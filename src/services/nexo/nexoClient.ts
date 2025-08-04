import nexoApiClient from './nexoApiClient'
import { FuturesPosition } from '../../nexo';
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

export class NexoClient extends AbstractDexClient {
	private readonly client: nexoApiClient;
	private readonly logger: CustomLogger;

	constructor() {
		super();

		this.logger = new CustomLogger('nexo');

		if (!process.env.NEXO_API_KEY || !process.env.NEXO_API_SECRET) {
			this.logger.warn('Credentials are not set as environment variable');
		}

		this.client = new nexoApiClient(
			process.env.NEXO_API_KEY!,
			process.env.NEXO_API_SECRET!
//			base_url: process.env.NODE_ENV !== 'production' ? 'https://api.sandbox.pro.nexo.com' : undefined,
		);
	}

	public async getIsAccountReady(): Promise<boolean> {
		try {
			// Fetched balance indicates connected wallet
			await this.client.getAccountBalances();
			return true;
		} catch (e) {
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
		openedPositions: FuturesPosition[],
		mutex: Mutex
	) {
		const orderParams = await this.buildOrderParams(alertMessage);

		const market = orderParams.market;
		const type = OrderType.LIMIT.toLowerCase();
		const side = orderParams.side;
		const mode = process.env.BYBIT_MODE || '';
		const direction = alertMessage.direction;

		if (side === OrderSide.BUY && mode.toLowerCase() === 'onlysell') return;

		const timeInForce = 'gtc';
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
			const position = openedPositions.find((el) => el.instrument === market);

			if (!position) {
				this.logger.log('order is ignored because position not exists');
				return;
			}

			const profit = calculateProfit(orderParams.price, parseFloat(position.entryPrice));
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

			const sum = Math.abs(parseFloat(position.quantity));

			size =
				orderMode === 'full' || newPositionSize == 0
					? sum
					: Math.min(size, sum);
		} else if (orderMode === 'full' || newPositionSize == 0) {
			const position = openedPositions.find((el) => el.instrument === market);
			if (!position) {
				if (newPositionSize == 0) {
					this.logger.log(
						'ignore this order because new position size is 0 and current position not exists'
					);
					return;
				}
			} else {
				if (
					(side === OrderSide.SELL && parseFloat(position.quantity) > 0) ||
					(side === OrderSide.BUY && parseFloat(position.quantity) < 0)
				)
					size = Math.abs(parseFloat(position.quantity));
			}
		}

		const postOnly = false;
		const reduceOnly = false;

		const fillWaitTime =
			parseInt(process.env.FILL_WAIT_TIME_SECONDS) * 1000 || 300 * 1000; // 5 minutes by default

		let positionIdx: number;
		if (direction == null) positionIdx = 0;
		else if (direction === 'long') positionIdx = 1;
		else if (direction === 'short') positionIdx = 2;

		const clientId = this.generateRandomHexString(32);
		this.logger.log('Client ID: ', clientId);

		// For cancelling if needed
		let orderId: string;

		// This solution fixes problem of two parallel calls in exchange, which is not possible
		// const release = await mutex.acquire();

		try {
			let positionAction: 'open' | 'close';
			if(direction === 'long' && side == OrderSide.BUY || direction === 'short' && OrderSide.SELL)
				positionAction = 'open';
			else 
				positionAction = 'close'
			const result = await this.client.placeFuturesOrder(
				{
					instrument: market,
					positionAction: positionAction,
					type: 'market',
					positionSide: direction,
					quantity: size.toString()
				}
			);
			
			this.logger.log('Transaction Result: ', result);
			orderId = result.id;
		} catch (e) {
			console.error(e);
		} finally {
			// release();
		}

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
			const order = await this.client.getFuturesOrderDetails(orderId);

			this.logger.log('Order ID: ', order.id);
			 return parseFloat(order.executedQuantity) >= parseFloat(order.quantity);
			
		} catch (e) {
			this.logger.log(e);
			return false;
		}
	};

	public getOpenedPositions = async (): Promise<FuturesPosition[]> => {
		const r =  await this.client.getFuturesPositions();
		return r.positions;
	};
}
