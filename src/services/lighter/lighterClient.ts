import { SignerClient } from 'lighter-ts-sdk';
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

export interface LighterPosition {
	symbol: string;
	position: string;
	avg_entry_price: string;
	market_id?: number;
	unrealized_pnl?: string;
	margin?: string;
}

export class LighterClient extends AbstractDexClient {
	private readonly client: SignerClient;
	private readonly apiClient: any;
	private readonly logger: CustomLogger;
	private initPromise: Promise<void>;
	private marketIndexCache: Map<string, number> = new Map();

	constructor() {
		super();

		this.logger = new CustomLogger('Lighter');

		if (!process.env.LIGHTER_API_SECRET || 
		    !process.env.LIGHTER_ACCOUNT_INDEX || 
		    !process.env.LIGHTER_API_KEY_INDEX) {
			this.logger.warn('Required credentials are not set. Need: LIGHTER_API_SECRET, LIGHTER_ACCOUNT_INDEX, LIGHTER_API_KEY_INDEX');
			return;
		}

		try {
			this.logger.log('Initializing with API Key Index:', process.env.LIGHTER_API_KEY_INDEX);
			this.logger.log('Account Index:', process.env.LIGHTER_ACCOUNT_INDEX);
			
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
			this.logger.log('Initializing SignerClient...');
			await this.client.initialize();
			
			if (typeof (this.client as any).ensureWasmClient === 'function') {
				this.logger.log('Ensuring WASM client...');
				await (this.client as any).ensureWasmClient();
			}
			
			this.logger.log('Creating ApiClient...');
			const { ApiClient } = await import('lighter-ts-sdk');
			const apiClient = new ApiClient({ 
				host: process.env.LIGHTER_API_URL || 'https://mainnet.zklighter.elliot.ai' 
			});
			
			(this as any).apiClient = apiClient;
			
			this.logger.log('ApiClient created:', {
				hasApiClient: !!this.apiClient,
				apiClientType: typeof this.apiClient
			});
			
			this.logger.log('Lighter client initialized successfully');
		} catch (e) {
			this.logger.error('Failed to initialize Lighter client:', e);
			throw e;
		}
	}

	public async getIsAccountReady(): Promise<boolean> {
		await this.initPromise;
		
		try {
			if (this.client && this.apiClient) {
				const { AccountApi } = await import('lighter-ts-sdk');
				const accountApi = new AccountApi(this.apiClient);
				
				const account = await accountApi.getAccount({ 
					by: 'index', 
					value: process.env.LIGHTER_ACCOUNT_INDEX! 
				});
				
				return !!account;
			}
			return false;
		} catch (e) {
			this.logger.error("getIsAccountReady error:", e);
			return false;
		}
	}

	private async buildOrderParams(alertMessage: AlertObject) {
		const orderSide =
			alertMessage.order == 'buy' ? OrderSide.BUY : OrderSide.SELL;

		const latestPrice = alertMessage.price;
		this.logger.log('latestPrice', latestPrice);

		let orderSize: number;
		orderSize = alertMessage.size;

		orderSize = doubleSizeIfReverseOrder(alertMessage, orderSize);

		const market = alertMessage.market;

		const orderParams: dydxV4OrderParams = {
			market,
			side: orderSide,
			size: Number(orderSize),
			price: Number(alertMessage.price)
		};
		this.logger.log('orderParams', orderParams);
		return orderParams;
	}

	public async placeOrder(
		alertMessage: AlertObject,
		openedPositions: any[],
		mutex: Mutex
	) {
		await this.initPromise;
		
		if (!this.apiClient) {
			this.logger.error('ApiClient not ready, cannot place order');
			throw new Error('ApiClient not initialized');
		}
		
		const orderParams = await this.buildOrderParams(alertMessage);

		const market = orderParams.market;
		
		const marketIndex = await this.getMarketIndex(market);
		const decimals = this.getMarketDecimals(market);
		const decimalFactor = Math.pow(10, decimals.size_decimals);
		
		const type = "LIMIT";
		let side: OrderSide = orderParams.side;
		const mode = process.env.LIGHTER_MODE || '';
		const direction = alertMessage.direction || null;

		if (side === OrderSide.BUY && mode.toLowerCase() === 'onlysell') return;

		const timeInForce = 'gtc';
		const slippagePercentage = parseFloat(alertMessage.slippagePercentage);
		const orderMode = alertMessage.orderMode || '';
		const newPositionSize = alertMessage.newPositionSize;
		const price =
			side == OrderSide.BUY
				? orderParams.price * ((100 + slippagePercentage) / 100)
				: orderParams.price * ((100 - slippagePercentage) / 100);

		let size = orderParams.size;

		if (
			(side === OrderSide.SELL && direction === 'long') ||
			(side === OrderSide.BUY && direction === 'short')
		) {
			const position = openedPositions.find((el) => el.market_id === marketIndex);

			if (!position) {
				this.logger.log('order is ignored because position not exists');
				return;
			}

			const profit = calculateProfit(orderParams.price, parseFloat(position.avg_entry_price) / 100);
			const minimumProfit =
				alertMessage.minProfit ??
				parseFloat(process.env.MINIMUM_PROFIT_PERCENT);

			if (
				(direction === 'long' && profit < minimumProfit) ||
				(direction === 'short' && -1 * profit < minimumProfit)
			) {
				this.logger.log(
					`Order is ignored because profit level not reached: current profit ${profit}, direction ${direction}`
				);
				return;
			}

			const sum = Math.abs(parseFloat(position.position));

			size =
				orderMode === 'full' || newPositionSize == 0
					? sum
					: Math.min(size, sum);
		} else if (orderMode === 'full' || newPositionSize == 0) {
			const position = openedPositions.find((el) => el.market_id === marketIndex);
			
			if (!position) {
				if (newPositionSize == 0) {
					this.logger.log(
						'ignore this order because new position size is 0 and current position not exists'
					);
					return;
				}
			} else {
				const positionSize = parseFloat(position.position);
				
				if (newPositionSize == 0) {
					size = Math.abs(positionSize);
					side = positionSize > 0 ? OrderSide.SELL : OrderSide.BUY;
				} else if (
					(side === OrderSide.SELL && positionSize > 0) ||
					(side === OrderSide.BUY && positionSize < 0)
				) {
					size = Math.abs(positionSize);
				}
			}
		}

		const postOnly = false;
		const reduceOnly = false;

		const fillWaitTime =
			parseInt(process.env.LIGHTER_FILL_WAIT_TIME_SECONDS || process.env.FILL_WAIT_TIME_SECONDS) * 1000 || 300 * 1000;

		let orderId: string;

		try {
			const baseAmount = Math.floor(size * decimalFactor);
			
			const priceFactor = Math.pow(10, decimals.price_decimals);
			const formattedPrice = Math.floor(price * priceFactor);
			
			this.logger.log(`Placing limit order: market=${market}, index=${marketIndex}, size=${size}, baseAmount=${baseAmount}, side=${side === OrderSide.SELL ? 'SELL' : 'BUY'}, price=${price.toFixed(2)} (formatted: ${formattedPrice})`);
			
			const orderExpiry = Date.now() + fillWaitTime;
			
			const [tx, txHash, err] = await this.client.createOrder({
				marketIndex: marketIndex,
				clientOrderIndex: Date.now(),
				baseAmount: baseAmount,
				price: formattedPrice,
				isAsk: side === OrderSide.SELL,
				orderType: (this.client.constructor as any).ORDER_TYPE_LIMIT,
				timeInForce: (this.client.constructor as any).ORDER_TIME_IN_FORCE_GOOD_TILL_TIME,
				reduceOnly: reduceOnly,
				triggerPrice: 0,
				orderExpiry: orderExpiry,
			});

			if (err) {
				this.logger.error('Order failed with error:', err);
				throw new Error(`Order failed: ${err}`);
			}

			this.logger.log('Order placed successfully:', { 
				tx: JSON.stringify(tx).substring(0, 100), 
				txHash: JSON.stringify(txHash).substring(0, 100)
			});
			
			orderId = (txHash as any)?.tx_hash || String(Date.now());
			
		} catch (e: any) {
			this.logger.error('Order placement error:', e);
			this.logger.error('Error details:', {
				message: e.message,
				stack: e.stack?.substring(0, 500)
			});
			throw e;
		}

		const orderResult: OrderResult = {
			side: orderParams.side,
			size: orderParams.size,
			orderId: String(orderId)
		};

		return orderResult;
	}

	private async getMarketIndex(symbol: string): Promise<number> {
		if (this.marketIndexCache.has(symbol)) {
			return this.marketIndexCache.get(symbol)!;
		}

		try {
			const { OrderApi } = await import('lighter-ts-sdk');
			const orderApi = new OrderApi(this.apiClient);
			const response = await orderApi.getOrderBooks();
			
			const orderBooks = (response as any)?.order_books || response;
			
			if (Array.isArray(orderBooks)) {
				for (let i = 0; i < orderBooks.length; i++) {
					const book = orderBooks[i] as any;
					if (book.symbol === symbol) {
						const marketIndex = book.market_id ?? i;
						
						const cacheKey = `${symbol}_decimals`;
						(this as any)[cacheKey] = {
							size_decimals: book.supported_size_decimals || 1,
							price_decimals: book.supported_price_decimals || 5
						};
						
						this.marketIndexCache.set(symbol, marketIndex);
						this.logger.log(`Found market ${symbol}: index=${marketIndex}, size_decimals=${book.supported_size_decimals}, price_decimals=${book.supported_price_decimals}`);
						return marketIndex;
					}
				}
			}
			
			this.logger.error(`Market ${symbol} not found in ${orderBooks?.length || 0} markets`);
			throw new Error(`Market ${symbol} not found`);
		} catch (e) {
			this.logger.error(`Error getting market index for ${symbol}:`, e);
			throw e;
		}
	}

	private getMarketDecimals(symbol: string): { size_decimals: number, price_decimals: number } {
		const cacheKey = `${symbol}_decimals`;
		return (this as any)[cacheKey] || { size_decimals: 1, price_decimals: 5 };
	}

	private isOrderFilled = async (
		orderId: string,
		market: string
	): Promise<boolean> => {
		try {
			return false;
		} catch (e) {
			this.logger.error("isOrderFilled error:", e);
			return false;
		}
	};

	public getOpenedPositions = async (): Promise<LighterPosition[]> => {
		await this.initPromise;
		
		try {
			const { AccountApi } = await import('lighter-ts-sdk');
			const accountApi = new AccountApi(this.apiClient);
			
			const response = await accountApi.getAccount({ 
				by: 'index', 
				value: process.env.LIGHTER_ACCOUNT_INDEX! 
			});

			const positions: LighterPosition[] = [];
			
			const targetAccountIndex = parseInt(process.env.LIGHTER_ACCOUNT_INDEX!);
			const account = (response as any)?.accounts?.find((acc: any) => acc.account_index === targetAccountIndex);
			
			if (!account) {
				this.logger.warn(`Account with index ${targetAccountIndex} not found`);
				return [];
			}
			
			if (account?.positions && Array.isArray(account.positions)) {
				for (const p of account.positions) {
					const positionSize = parseFloat(p.position || '0');
					
					if (Math.abs(positionSize) > 0) {
						positions.push({
							symbol: p.symbol,
							position: p.position,
							avg_entry_price: p.avg_entry_price,
							market_id: p.market_id,
							unrealized_pnl: p.unrealized_pnl,
							margin: p.margin,
						});
					}
				}
			}
			
			return positions;
		} catch (e) {
			this.logger.error("getOpenedPositions error:", e);
			return [];
		}
	};
}
