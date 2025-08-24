import asterApiClient from './asterApiClient'
import { Position } from '../../aster';
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

export class AsterClient extends AbstractDexClient {
	private readonly client: asterApiClient;
	private readonly logger: CustomLogger;

	constructor() {
		super();

		this.logger = new CustomLogger('Aster');

		if (!process.env.ASTER_API_KEY || !process.env.ASTER_API_SECRET) {
			this.logger.warn('Credentials are not set as environment variable');
			return;
		}

		this.client = new asterApiClient( {
				apiKey: process.env.ASTER_API_KEY!,
				apiSecret: process.env.ASTER_API_SECRET!
			}

		);
	}

	public async getIsAccountReady(): Promise<boolean> {
		try {
			if (client)
			{
				// Fetched balance indicates connected wallet
				await this.client.getAccountBalances();
				return true;
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
		openedPositions: Position[],
		mutex: Mutex
	) {
		const orderParams = await this.buildOrderParams(alertMessage);

		const market = orderParams.market;
		const type = "LIMIT";
		let side: OrderSide = orderParams.side;
		const mode = process.env.ASTER_MODE || '';
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

			const sum = Math.abs(position.positionAmt);

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
					(side === OrderSide.SELL && position.positionAmt > 0) ||
					(side === OrderSide.BUY && position.positionAmt < 0)
				)
					size = Math.abs(position.positionAmt);
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
			const positionSide = direction === 'long' ? 'LONG' : 'SHORT';

                        if(direction === 'long' && side == OrderSide.BUY || direction === 'short' && OrderSide.SELL)
                                side = OrderSide.BUY;
                        else
                                side = OrderSide.SELL;


			const result = await this.client.placeOrder(
				{
					symbol: market,
					type: type,
					positionSide:  positionSide,
					side: side,
					quantity: size, 
					price: price
				}
			);
			
			this.logger.log('Transaction Result: ', result);
			orderId = result.orderId;
		} catch (e) {
			console.error(e);
		} finally {
			// release();
		}

                await _sleep(fillWaitTime);

                const isFilled = await this.isOrderFilled(orderId, market);
                if (!isFilled) {
                        // const release = await mutex.acquire();

                        try {
                                await this.client.cancelOrder(market, orderId);
                                this.logger.log(`Order ID ${orderId} canceled`);
                        } catch (e) {
                                this.logger.log(e);
                        } finally {
                                // release();
			}
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
			const order = await this.client.getOrderDetails(market, orderId);
			return order.executedQty >= order.origQty;
		    } catch (e) {
			this.logger.error("isOrderFilled error:", e);
			return false;
		    }
	};

	public getOpenedPositions = async (): Promise<Position[]> => {
		return  await this.client.getPositions();
	};
}
