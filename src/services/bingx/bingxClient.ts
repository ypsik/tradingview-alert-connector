import * as ccxt from 'ccxt';
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
import limit from 'simple-rate-limiter';

export class BingxClient extends AbstractDexClient {
	private readonly client: ccxt.bingx;
	private readonly logger: CustomLogger;

	constructor() {
		super();

		this.logger = new CustomLogger('Bingx');

		if (!process.env.BINGX_API_KEY || !process.env.BINGX_SECRET) {
			this.logger.warn('Credentials are not set as environment variable');
		}

		this.client = new ccxt.bingx({
			apiKey: process.env.BINGX_API_KEY,
			secret: process.env.BINGX_SECRET,
			enableRateLimit: true
		});
		this.client.rateLimit = 300;

		if (process.env.NODE_ENV !== 'production') this.client.setSandboxMode(true);
	}

	public async getIsAccountReady(): Promise<boolean> {
		try {
			// Fetched balance indicates connected wallet
			await this.client.fetchBalance();
			return true;
		} catch (e) {
			return false;
		}
	}

	private limitedCreateOrder = limit(this.createOrder.bind(this)).to(4).per(1000); 
	public async createOrder(orderData: any) {
	    // Logik zum Erstellen einer Order bei BingX
	}

	public async createOrderWithLimit(orderData: any) {
	    await this.limitedCreateOrder(orderData);
  	}

	private async buildOrderParams(alertMessage: AlertObject) {
		const orderSide =
			alertMessage.order == 'buy' ? OrderSide.BUY : OrderSide.SELL;

		const latestPrice = alertMessage.price;
		this.logger.log('latestPrice', latestPrice);

		let orderSize: number;
		orderSize = alertMessage.size;

		orderSize = doubleSizeIfReverseOrder(alertMessage, orderSize);

		const market = alertMessage.market.replace(/_/g, '-');

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
		openedPositions: ccxt.Position[],
		mutex: Mutex
	) {
		const orderParams = await this.buildOrderParams(alertMessage);

		const market = orderParams.market;
		const type = OrderType.LIMIT;
		const side = orderParams.side;
		const mode = process.env.BINGX_MODE || '';
		const direction = alertMessage.direction;

		if (side === OrderSide.BUY && mode.toLowerCase() === 'onlysell') return;

		const timeInForce = 'GTC';
		const slippagePercentage = parseFloat(alertMessage.slippagePercentage); // Get from alert
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
			const position = openedPositions.find((el) => el.symbol === market);

			if (!position) {
				this.logger.log('order is ignored because position not exists');
				return;
			}

			const profit = calculateProfit(orderParams.price, position.entryPrice);
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

			const sum = Math.abs(position.contracts);

			size =
				orderMode === 'full' || newPositionSize == 0
					? sum
					: Math.min(size, sum);
		} else if (orderMode === 'full' || newPositionSize == 0) {
			const position = openedPositions.find((el) => el.symbol === market);
			if (!position) {
				if (newPositionSize == 0) {
					this.logger.log(
						'ignore this order because new position size is 0 and current position not exists'
					);
					return;
				}
			} else {
				if (
					(side === OrderSide.SELL && position.contracts > 0) ||
					(side === OrderSide.BUY && position.contracts < 0)
				)
					size = Math.abs(position.contracts);
			}
		}

		const postOnly = false;
		const reduceOnly = false;

		const fillWaitTime =
			parseInt(process.env.FILL_WAIT_TIME_SECONDS) * 1000 || 300 * 1000; // 5 minutes by default

		const clientId = this.generateRandomHexString(32);
		this.logger.log('Client ID: ', clientId);

		// For cancelling if needed
		let orderId: string;

		// This solution fixes problem of two parallel calls in exchange, which is not possible
		// const release = await mutex.acquire();

		try {
			const result = await this.client.createOrder(
				market,
				type,
				side.toLowerCase(),
				size,
				price,
				{
					clientOrderId: clientId,
					timeInForce,
					postOnly,
					// reduceOnly,
					positionSide: direction.toUpperCase()
				}
			);
			this.logger.log('Transaction Result: ', result);
			orderId = result.id;
		} catch (e) {
			console.error(e);
		} finally {
			// release();
		}

		setTimeout(async () => {

			const isFilled = await this.isOrderFilled(orderId, market);
			if (!isFilled) {
				// const release = await mutex.acquire();

				try {
					await this.client.cancelOrder(orderId, market, {
						clientOrderId: clientId
					});
					this.logger.log(`Order ID ${orderId} canceled`);
				} catch (e) {
					this.logger.log(e);
				} finally {
					// release();
				}
			}
		}, fillWaitTime);

		const orderResult: OrderResult = {
			side: orderParams.side,
			size: orderParams.size,
			orderId: String(clientId)
		};

		return orderResult;
	}

	private generateRandomHexString(size: number): string {
		return `0x${[...Array(size)]
			.map(() => Math.floor(Math.random() * 16).toString(16))
			.join('')}`;
	}

	private isOrderFilled = async (
		orderId: string,
		market: string
	): Promise<boolean> => {
		try {
			const orders = await this.client.fetchOpenOrders(market);

			const order = orders.find((el) => el.id === orderId);

			this.logger.log('Order ID: ', order.id);

			return order.status == 'closed';
		} catch (e) {
			this.logger.log(e);
			return false;
		}
	};

	public getOpenedPositions = async (): Promise<ccxt.Position[]> => {
		return this.client.fetchPositions();
	};
}
