import { SignerClient } from 'lighter-ts-sdk';
import { AccountPosition } from 'lighter-ts-sdk/dist/api/account-api';
import { dydxV4OrderParams, AlertObject, OrderResult } from '../../types';
import {
	_sleep,
	calculateProfit,
	doubleSizeIfReverseOrder
} from '../../helper';
import 'dotenv/config';
import { OrderSide, OrderType } from '@dydxprotocol/v4-client-js';
import { AbstractDexClient } from '../abstractDexClient';
import { Mutex } from 'async-mutex';
import { CustomLogger } from '../logger/logger.service';

export class LighterClient extends AbstractDexClient {
	private readonly client: SignerClient;
	private apiClient: any; 
	private wsClient: any;
	private readonly logger: CustomLogger;
	private initPromise: Promise<void>;
	private marketIndexCache: Map<string, number> = new Map();
	private cachedPositions: AccountPosition[] = [];
	private wsConnected: boolean = false;
	private reconnectAttempts = 0;
	private maxReconnectAttempts = 10;
	private isReconnecting = false;
	private readonly reconnectMutex = new Mutex();
	private heartbeatTimer: any = null; // Timer für aktiven Ping
	
	constructor() {
		super();
		this.logger = new CustomLogger('Lighter');

		if (!process.env.LIGHTER_API_SECRET || !process.env.LIGHTER_ACCOUNT_INDEX || !process.env.LIGHTER_API_KEY_INDEX) {
			this.logger.warn('Required credentials are not set.');
			return;
		}

		try {
			this.client = new SignerClient({
				url: process.env.LIGHTER_API_URL || 'https://mainnet.zklighter.elliot.ai',
				privateKey: process.env.LIGHTER_API_SECRET!,
				accountIndex: parseInt(process.env.LIGHTER_ACCOUNT_INDEX!),
				apiKeyIndex: parseInt(process.env.LIGHTER_API_KEY_INDEX!),
			});
			this.initPromise = this.initialize();
		} catch (e) {
			this.logger.error('Failed to create Lighter client:', e);
			throw e;
		}
	}

	private async initialize(): Promise<void> {
		try {
			await this.client.initialize();
			if (typeof (this.client as any).ensureWasmClient === 'function') await (this.client as any).ensureWasmClient();
			const { ApiClient } = await import('lighter-ts-sdk');
			this.apiClient = new ApiClient({ host: process.env.LIGHTER_API_URL || 'https://mainnet.zklighter.elliot.ai' });
			(this as any).apiClient = this.apiClient;
			await this.initializeWebSocket();
		} catch (e) {
			throw e;
		}
	}

	private async initializeWebSocket(): Promise<void> {
		try {
			// Cleanup vor dem Start
			if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
			if (this.wsClient) {
				this.wsClient.onOpen = null; this.wsClient.onClose = null; 
				this.wsClient.onError = null; this.wsClient.onMessage = null;
				try { this.wsClient.close(); } catch (e) {}
			}

			const { WsClient } = await import('lighter-ts-sdk');
			const wsUrl = (process.env.LIGHTER_API_URL || 'https://mainnet.zklighter.elliot.ai').replace('https://', 'wss://').replace('http://', 'ws://');
			
			this.wsClient = new WsClient({ 
				url: `${wsUrl}/stream`,
				onOpen: () => {
					this.wsConnected = true;
					this.reconnectAttempts = 0; 
					this.logger.log('WebSocket connected');

					// AKTIVER PING: Alle 30s senden, um Disconnects zu verhindern
					this.heartbeatTimer = setInterval(() => {
						if (this.wsConnected && this.wsClient) {
							try { this.wsClient.send({ type: 'ping' }); } catch (e) {}
						}
					}, 30000);
				},
				onClose: () => {
					if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
					this.logger.warn('WebSocket closed');
					this.wsConnected = false;
					this.triggerReconnect();
				},
				onError: (error: Error) => {
					if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
					this.wsConnected = false;
					this.triggerReconnect();
				},
				onMessage: (message: any) => {
					if (message.type === 'ping' || message === 'ping') {
						try { this.wsClient.send({ type: 'pong' }); } catch (e) {}
						return;
					}									
					const rawData = message.positions || message.assets;
					if (rawData && typeof rawData === 'object') {
						const positions: AccountPosition[] = [];
						for (const [id, pos] of Object.entries(rawData)) {
							const p = pos as any;
							if (Math.abs(parseFloat(p.position || p.balance || '0')) > 0) {
								positions.push(p as AccountPosition);
							}
						}
						this.cachedPositions = positions;
						this.logger.log(`WS: Updated ${this.cachedPositions.length} positions`);
					}
				}
			});
			
			await this.wsClient.connect();
			const accountIndex = parseInt(process.env.LIGHTER_ACCOUNT_INDEX!);
			this.wsClient.send({ type: 'subscribe', channel: `account_all/${accountIndex}` });
		} catch (e) {
			this.wsConnected = false;
		}
	}

	private triggerReconnect(): void {
		if (this.reconnectMutex.isLocked()) return;
		this.isReconnecting = true; 
		this.reconnectWebSocket().catch(() => { this.isReconnecting = false; });
	}

	private async reconnectWebSocket(): Promise<void> {
		await this.reconnectMutex.runExclusive(async () => {
			if (this.wsConnected) return;
			await _sleep(10000); // 10s warten gegen 429er Sperre
			
			while (this.reconnectAttempts < this.maxReconnectAttempts) {
				this.reconnectAttempts++;
				this.logger.log(`Retry ${this.reconnectAttempts}/${this.maxReconnectAttempts}`);
				try {
					await this.initializeWebSocket();
					await _sleep(5000);
					if (this.wsConnected) {
						this.isReconnecting = false;
						return;
					}
				} catch (e) {}
				await _sleep(Math.min(10000 * Math.pow(2, this.reconnectAttempts - 1), 60000));
			}
			this.isReconnecting = false;
		});
	}

	public async getIsAccountReady(): Promise<boolean> {
		await this.initPromise;
		try {
			const { AccountApi } = await import('lighter-ts-sdk');
			const accountApi = new AccountApi(this.apiClient);
			const account = await accountApi.getAccount({ by: 'index', value: process.env.LIGHTER_ACCOUNT_INDEX! });
			return !!account;
		} catch (e) { return false; }
	}

	public async placeOrder(alertMessage: AlertObject, openedPositions: any[], mutex: Mutex) {
		await this.initPromise;
		const side = alertMessage.order == 'buy' ? OrderSide.BUY : OrderSide.SELL;
		const marketIndex = await this.getMarketIndex(alertMessage.market);
		const decimals = this.getMarketDecimals(alertMessage.market);
		const slippage = parseFloat(alertMessage.slippagePercentage);
		const price = side == OrderSide.BUY ? alertMessage.price * (1 + slippage/100) : alertMessage.price * (1 - slippage/100);

		let size = doubleSizeIfReverseOrder(alertMessage, alertMessage.size);
		const positions = (this.wsConnected && this.cachedPositions.length > 0) ? this.cachedPositions : openedPositions;

		const pos = positions.find((el) => el.market_id === marketIndex);
		if (pos && alertMessage.direction) {
			const current = Math.abs(parseFloat((pos as any).position || (pos as any).balance || pos.size || '0'));
			if (alertMessage.orderMode === 'full' || alertMessage.newPositionSize == 0) size = current;
		}

		try {
			const [tx, txHash, err] = await this.client.createOrder({
				marketIndex,
				clientOrderIndex: Date.now(),
				baseAmount: Math.floor(size * Math.pow(10, decimals.size_decimals)),
				price: Math.floor(price * Math.pow(10, decimals.price_decimals)),
				isAsk: side === OrderSide.SELL,
				orderType: (this.client.constructor as any).ORDER_TYPE_LIMIT,
				timeInForce: (this.client.constructor as any).ORDER_TIME_IN_FORCE_GOOD_TILL_TIME,
				reduceOnly: false, triggerPrice: 0, orderExpiry: Date.now() + 300000,
			});
			if (err) throw new Error(err);
			return { side, size, orderId: (txHash as any)?.tx_hash || String(Date.now()) };
		} catch (e: any) {
			throw e;
		}
	}

	private async getMarketIndex(symbol: string): Promise<number> {
		if (this.marketIndexCache.has(symbol)) return this.marketIndexCache.get(symbol)!;
		const { OrderApi } = await import('lighter-ts-sdk');
		const orderApi = new OrderApi(this.apiClient);
		const res = await orderApi.getOrderBooks();
		const books = (res as any)?.order_books || res;
		const book = books.find((b: any) => b.symbol === symbol);
		if (book) {
			(this as any)[`${symbol}_decimals`] = { size_decimals: book.supported_size_decimals, price_decimals: book.supported_price_decimals };
			this.marketIndexCache.set(symbol, book.market_id);
			return book.market_id;
		}
		throw new Error('Market not found');
	}

	private getMarketDecimals(symbol: string) {
		return (this as any)[`${symbol}_decimals`] || { size_decimals: 1, price_decimals: 5 };
	}

	public getOpenedPositions = async (): Promise<AccountPosition[]> => {
		await this.initPromise;
		try {
			const { AccountApi } = await import('lighter-ts-sdk');
			const accountApi = new AccountApi(this.apiClient);
			const res = await accountApi.getAccount({ by: 'index', value: process.env.LIGHTER_ACCOUNT_INDEX! });
			const acc = (res as any)?.accounts?.find((a: any) => a.account_index === parseInt(process.env.LIGHTER_ACCOUNT_INDEX!));
			return acc?.positions?.filter((p: any) => Math.abs(parseFloat(p.position || p.balance || '0')) > 0) || [];
		} catch (e) { return []; }
	};
}
