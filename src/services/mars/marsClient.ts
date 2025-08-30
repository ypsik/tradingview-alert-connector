import { Connection, Keypair, PublicKey  } from '@solana/web3.js';
import * as anchor from '@coral-xyz/anchor';
import { AnchorProvider, Wallet, Program, Idl } from '@coral-xyz/anchor';
import * as drift from '@drift-labs/sdk';

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
import * as bip39 from 'bip39';
import { derivePath } from 'ed25519-hd-key';

import { OpenPosition } from '../../mars';

import marsPerpsClient from './marsPerpsClient'

interface ExtractedTriggerOrder {
  order_id: string;
  denom: string;
  size: string;
  price: string;
  direction: "long" | "short";
}

export class MarsClient extends AbstractDexClient {
	private client: marsPerpsClient; 
	private account_id: string;
	private readonly logger: CustomLogger;	
	private readyPromise: Promise<void>;
	constructor() {
		super();

		this.logger = new CustomLogger('Mars');

		if (
			!process.env.MARS_MNEMONIC || !process.env.MARS_RPC_SERVER
		) {
			this.logger.warn('Credentials are not set as environment variable'); 
			return;
		}
		
		this.client = new marsPerpsClient(process.env.MARS_RPC_SERVER, process.env.MARS_MNEMONIC);
		this.account_id = process.env.MARS_ACCOUNT_ID;
		this.readyPromise = this.init();
	}              

	private async init()
	{
		await this.client.init();
		if(!this.account_id)
			this.account_id = await this.client.ensureAccount();
	}


	public async getIsAccountReady(): Promise<boolean> {
		await this.readyPromise;
		try {
			// Fetched balance indicates connected wallet
			await this.client.getBalance(this.client.getAddress());
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
		openedPositions: OpenPosition[],
		mutex: Mutex
	) {
		await this.readyPromise;           

		const orderParams = await this.buildOrderParams(alertMessage);

		const market = orderParams.market;
		const type = OrderType.LIMIT;
		const side = orderParams.side;
		const mode = process.env.MARS_MODE || '';
		const direction = alertMessage.direction;

		if (side === OrderSide.BUY && mode.toLowerCase() === 'onlysell') return;

		const timeInForce = 'gtc';
		const slippagePercentage = parseFloat(alertMessage.slippagePercentage); // Get from alert
		const vaultAddress = process.env.HYPERLIQUID_VAULT_ADDRESS;
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
			// Drift  group all positions in one position per symbol
			const position = openedPositions.find((el) =>  el.market === market);

			if (!position) {
				this.logger.log('order is ignored because position not exists');
				return;
			}
			
			const profit = calculateProfit(orderParams.price, parseFloat(position.entry_price));

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

			const sum = position.size;

			size =
				orderMode === 'full' || newPositionSize == 0
					? sum
					: Math.min(size, sum);
		} else if (orderMode === 'full' || newPositionSize == 0) {
			const position = openedPositions.find((el) => el.market === market);

			if (!position) {
				if (newPositionSize == 0) {
					this.logger.log(
						'ignore this order because new position size is 0 and current position not exists'
					);
					return;
				}
			} else {
				if (
					(side === OrderSide.SELL &&  position.side === 'long') ||
					(side === OrderSide.BUY && position.side === 'short')
				)
					size = position.size;
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
		//		const release = await mutex.acquire();

		
		try {				
                        await this.client.placeMarketOrder( {
			  accountId: this.account_id,          
			  denom: market,       
			  size: size,         
			  direction: side === OrderSide.BUY ? 'long' : 'short' , 
			  reduceOnly: reduceOnly,
			});
			this.logger.log('Transaction sent');
		} catch (e) {
			this.logger.error(e);
		} finally {
			//			release();
		}
		
		const orderResult: OrderResult = {
			side: orderParams.side,
			size: orderParams.size,
			orderId: undefined
		};

		return orderResult;
	}

	private generateRandomHexString(size: number): string {
		return `0x${[...Array(size)]
			.map(() => Math.floor(Math.random() * 16).toString(16))
			.join('')}`;
	}

	private parseTriggerOrder(order: any): ExtractedTriggerOrder | null {
	  // execute_perp_order finden
	  const execAction = order.actions.find(a => 'execute_perp_order' in a)?.execute_perp_order;
	  if (!execAction) return null;

	  // oracle_price condition finden
	  const priceCondition = order.conditions.find(c => 'oracle_price' in c)?.oracle_price;
	  if (!priceCondition) return null;

	  return {
	    order_id: order.order_id,
	    denom: execAction.denom,
	    size: execAction.order_size,
	    price: priceCondition.price,
	    direction: priceCondition.comparison === "less_than" ? "long" : "short"
	  };
	}

	public getOpenedPositions = async (): Promise<OpenPosition[]> =>
	{
		await this.readyPromise;
		const result = await this.client.getOpenPositions(this.account_id);
		return result.positions;
	};
}
