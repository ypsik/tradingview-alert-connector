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
	private wsClient: any = null;
	private readonly logger: CustomLogger;
	private initPromise: Promise<void>;
	private marketIndexCache: Map<string, number> = new Map();
	private cachedPositions: AccountPosition[] = [];
	private wsConnected: boolean = false;
	private reconnectAttempts = 0;
	private maxReconnectAttempts = 100;
	
	private isReconnecting = false; 
	private heartbeatTimer: any = null;
	private readonly reconnectMutex = new Mutex();
	
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
			if (typeof (this.client as any).ensureWasmClient === 'function') {
				await (this.client as any).ensureWasmClient();
			}
			const { ApiClient } = await import('lighter-ts-sdk');
			this.apiClient = new ApiClient({ host: process.env.LIGHTER_API_URL || 'https://mainnet.zklighter.elliot.ai' });
			(this as any).apiClient = this.apiClient;
			await this.initializeWebSocket();
		} catch (e) {
			this.logger.error('Failed to initialize:', e);
			throw e;
		}
	}

	private destroyClient(): void {
		if (this.heartbeatTimer) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = null;
		}
		if (this.wsClient) {
			try { this.wsClient.onOpen = () => {}; } catch(e) {}
			try { this.wsClient.onClose = () => {}; } catch(e) {}
			try { this.wsClient.onError = () => {}; } catch(e) {}
			try { this.wsClient.onMessage = () => {}; } catch(e) {}
			try { 
				if (typeof this.wsClient.disconnect === 'function') this.wsClient.disconnect();
				else if (typeof this.wsClient.close === 'function') this.wsClient.close();
			} catch (e) {}
			this.wsClient = null;
		}
	}

	private async initializeWebSocket(): Promise<void> {
		try {
			this.destroyClient();

			const { WsClient } = await import('lighter-ts-sdk');
			const wsUrl = (process.env.LIGHTER_API_URL || 'https://mainnet.zklighter.elliot.ai').replace('https://', 'wss://').replace('http://', 'ws://');
			
			const newInstance = new WsClient({ 
				url: `${wsUrl}/stream`,
				onOpen: () => {
					if (this.wsClient !== newInstance) return;

					if (!this.wsConnected) {
						this.logger.log('WebSocket connected successfully');
					}
					
					this.wsConnected = true;
					this.reconnectAttempts = 0; 
					
					// Echter Ping alle 30s gegen den 60s Disconnect
					if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
					this.heartbeatTimer = setInterval(() => {
						if (this.wsConnected && this.wsClient === newInstance) {
							try { newInstance.send({ type: 'ping' }); } catch(e) {}
						}
					}, 30000); 
				},
				onClose: () => {
					if (this.wsClient === newInstance) {
						this.logger.warn('WebSocket closed -> Triggering recovery');
						this.wsConnected = false;
						this.triggerReconnect();
					}
				},
				onError: (error: Error) => {
					if (this.wsClient === newInstance) {
						this.logger.warn('WebSocket error -> Triggering recovery');
						this.wsConnected = false;
						this.triggerReconnect();
					}
				},
				onMessage: (message: any) => {
					if (message.type === 'ping') {
						try { newInstance.send({ type: 'pong' }); } catch (e) {}
						return;
					}
					if (message.type === 'pong') return; // Server antwortet auf unseren Ping
					
					if (message.error) {
						if (message.error.code !== 30009) {
							this.logger.warn('WS API Error: ' + JSON.stringify(message.error));
						}
						return;
					}

					// WICHTIG: Das Log für einkommende Nachrichten ist wieder da!
					if (message.type !== 'connected') {
						this.logger.log('WebSocket message:', JSON.stringify(message).substring(0, 200));
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
						
						// WICHTIG: Hier ist dein Positions-Update Log!
						this.logger.log(`WS: Updated ${this.cachedPositions.length} positions`);
					}
				}
			});
			
			this.wsClient = newInstance;
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
		
		this.reconnectWebSocket().finally(() => { 
			this.isReconnecting = false; 
		});
	}

	private async reconnectWebSocket(): Promise<void> {
		await this.reconnectMutex.runExclusive(async () => {
			if (this.wsConnected) { this.isReconnecting = false; return; }

			this.logger.log('Starting 5s cooldown before reconnect...');
			this.destroyClient(); 
			await _sleep(5000); 
			
			while (this.reconnectAttempts < this.maxReconnectAttempts) {
				this.reconnectAttempts++;
				this.logger.log(`Reconnect attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts}`);
				try {
					await this.initializeWebSocket();
					await _sleep(5000); 
					if (this.wsConnected) { 
						this.logger.log('Connection recovered!');
						this.isReconnecting = false;
						return;
					}
				} catch (e) {}
				
				const delay = Math.min(5000 * Math.pow(2, this.reconnectAttempts - 1), 60000);
				this.logger.log(`Waiting ${delay / 1000}s for next attempt...`);
				await _sleep(delay);
			}
			this.logger.error('Max reconnect attempts reached.');
			this.isReconnecting = false;
		});
	}

	public async getIsAccountReady(): Promise<boolean> {
		await this.initPromise;
		try {
			if (this.client && this.apiClient) {
				const { AccountApi } = await import('lighter-ts-sdk');
				const accountApi = new AccountApi(this.apiClient);
				const account = await accountApi.getAccount({ by: 'index', value: process.env.LIGHTER_ACCOUNT_INDEX! });
				return !!account;
			}
			return false;
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

		if (pos) {
			const currentSize = Math.abs(parseFloat((pos as any).position || (pos as any).balance || pos.size || '0'));
			if (String(alertMessage.newPositionSize) === "0" || alertMessage.orderMode === 'full') {
				this.logger.log(`Overshoot protection: Setting close size to exact position size: ${currentSize}`);
				size = currentSize;
			}
		} else if (String(alertMessage.newPositionSize) === "0") return;

		try {
			const baseAmount = Math.floor(size * Math.pow(10, decimals.size_decimals));
			const formattedPrice = Math.floor(price * Math.pow(10, decimals.price_decimals));
			
			if (baseAmount <= 0) return;

			const [tx, txHash, err] = await this.client.createOrder({
				marketIndex,
				clientOrderIndex: Date.now(),
				baseAmount,
				price: formattedPrice,
				isAsk: side === OrderSide.SELL,
				orderType: (this.client.constructor as any).ORDER_TYPE_LIMIT,
				timeInForce: (this.client.constructor as any).ORDER_TIME_IN_FORCE_GOOD_TILL_TIME,
				reduceOnly: false, triggerPrice: 0, orderExpiry: Date.now() + 300000,
			});
			if (err) throw new Error(err);
			return { side, size, orderId: (txHash as any)?.tx_hash || String(Date.now()) };
		} catch (e: any) { throw e; }
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

	private getMarketDecimals(symbol: string) { return (this as any)[`${symbol}_decimals`] || { size_decimals: 1, price_decimals: 5 }; }

	public getOpenedPositions = async (): Promise<AccountPosition[]> => {
		await this.initPromise;
		try {
			const { AccountApi } = await import('lighter-ts-sdk');
			const accountApi = new AccountApi(this.apiClient);
			const res = await accountApi.getAccount({ by: 'index', value: process.env.LIGHTER_ACCOUNT_INDEX! });
			const acc = (res as any)?.accounts?.find((a: any) => a.account_index === parseInt(process.env.LIGHTER_ACCOUNT_INDEX!));
			return acc?.positions?.filter((p: any) => Math.abs(parseFloat(p.position || p.balance || '0')) > 0) || [];
		} catch (e) { return []; }
	}
}
