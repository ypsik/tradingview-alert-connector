import {
	BECH32_PREFIX,
	IndexerClient,
	CompositeClient,
	Network,
	SubaccountClient,
	ValidatorConfig,
	LocalWallet,
	OrderExecution,
	OrderSide,
	OrderTimeInForce,
	OrderType,
	IndexerConfig,
	PositionStatus
} from '@dydxprotocol/v4-client-js';
import {
	dydxV4OrderParams,
	AlertObject,
	OrderResult,
	PositionData,
	MarketData
} from '../../types';
import { calculateProfit, doubleSizeIfReverseOrder } from '../../helper';
import 'dotenv/config';
import config from 'config';
import { AbstractDexClient } from '../abstractDexClient';
import { Mutex } from 'async-mutex';
import { CustomLogger } from '../logger/logger.service';

export class DydxV4Client extends AbstractDexClient {
	private readonly logger: CustomLogger;

	constructor() {
		super();

		this.logger = new CustomLogger('DydxV4');
	}

	public async getIsAccountReady() {
		const subAccount = await this.getSubAccount();
		if (!subAccount) return false;

		this.logger.log('Account: ' + JSON.stringify(subAccount, null, 2));
		return (Number(subAccount.freeCollateral) > 0) as boolean;
	}

	private async getSubAccount() {
		try {
			const client = this.buildIndexerClient();
			const localWallet = await this.generateLocalWallet();
			if (!localWallet) return;
			const response = await client.account.getSubaccount(
				localWallet.address,
				0
			);

			return response.subaccount;
		} catch (error) {
			this.logger.error(error);
		}
	}

	private async buildOrderParams(alertMessage: AlertObject) {
		const orderSide =
			alertMessage.order == 'buy' ? OrderSide.BUY : OrderSide.SELL;

		const latestPrice = alertMessage.price;
		this.logger.log('latestPrice', latestPrice);

		let orderSize: number;
		if (alertMessage.sizeByLeverage) {
			const account = await this.getSubAccount();

			orderSize =
				(Number(account.equity) * Number(alertMessage.sizeByLeverage)) /
				latestPrice;
		} else if (alertMessage.sizeUsd) {
			orderSize = Number(alertMessage.sizeUsd) / latestPrice;
		} else {
			orderSize = alertMessage.size;
		}

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
		openedPositions: MarketData[],
		mutex: Mutex
	) {
		const orderParams = await this.buildOrderParams(alertMessage);
		const { client, subaccount } = await this.buildCompositeClient();

		const market = orderParams.market;
		const type = OrderType.LIMIT;
		const side = orderParams.side;
		const mode = process.env.DYDX_V4_MODE || '';
		const direction = alertMessage.direction;

		if (side === OrderSide.BUY && mode.toLowerCase() === 'onlysell') return;

		const timeInForce = OrderTimeInForce.GTT;
		const execution = OrderExecution.DEFAULT;
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
			// dydx group all positions in one position per symbol
			const position = openedPositions.find((el) => el.market === market);

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

			const sum = Math.abs(position.size);

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
					(side === OrderSide.SELL && position.size > 0) ||
					(side === OrderSide.BUY && position.size < 0)
				)
					size = Math.abs(position.size);
			}
		}
		const postOnly = false;
		const reduceOnly = false;

		const fillWaitTime = Number(process.env.FILL_WAIT_TIME_SECONDS) || 300; // 5 minutes by default

		const clientId = this.generateRandomInt32();
		this.logger.log('Client ID: ', clientId);

		// This solution fixes problem of two parallel calls in exchange, which is not possible
		const release = await mutex.acquire();

		try {
			const tx = await client.placeOrder(
				subaccount,
				market,
				type,
				side,
				price,
				size,
				clientId,
				timeInForce,
				fillWaitTime,
				execution,
				postOnly,
				reduceOnly
			);
			this.logger.log('Transaction Result: ', tx);
		} catch (e) {
			this.logger.error(e);
		} finally {
			release();
		}

		const orderResult: OrderResult = {
			side: orderParams.side,
			size: orderParams.size,
			orderId: String(clientId)
		};
		// await this.exportOrder(
		//	'DydxV4',
		//	alertMessage.strategy,
		//	orderResult,
		//	alertMessage.price,
		//	alertMessage.market
		// );

		return orderResult;
	}

	private buildCompositeClient = async () => {
		const validatorConfig = new ValidatorConfig(
			config.get('DydxV4.ValidatorConfig.restEndpoint'),
			'dydx-mainnet-1',
			{
				CHAINTOKEN_DENOM: 'adydx',
				CHAINTOKEN_DECIMALS: 18,
				USDC_DENOM:
					'ibc/8E27BA2D5493AF5636760E354E46004562C46AB7EC0CC4C1CA14E9E20E2545B5',
				USDC_GAS_DENOM: 'uusdc',
				USDC_DECIMALS: 6
			}
		);
		const network =
			process.env.NODE_ENV == 'production'
				? new Network('mainnet', this.getIndexerConfig(), validatorConfig)
				: Network.testnet();
		let client;
		try {
			client = await CompositeClient.connect(network);
		} catch (e) {
			this.logger.error(e);
			throw new Error('Failed to connect to dYdX v4 client');
		}

		const localWallet = await this.generateLocalWallet();
		const subaccount = new SubaccountClient(localWallet, 0);
		return { client, subaccount };
	};

	private generateLocalWallet = async () => {
		if (!process.env.DYDX_V4_MNEMONIC) {
			this.logger.warn('DYDX_V4_MNEMONIC is not set as environment variable');
			return;
		}

		const localWallet = await LocalWallet.fromMnemonic(
			process.env.DYDX_V4_MNEMONIC,
			BECH32_PREFIX
		);

		return localWallet;
	};

	private buildIndexerClient = () => {
		const mainnetIndexerConfig = this.getIndexerConfig();
		const indexerConfig =
			process.env.NODE_ENV !== 'production'
				? Network.testnet().indexerConfig
				: mainnetIndexerConfig;
		return new IndexerClient(indexerConfig);
	};

	private getIndexerConfig = () => {
		return new IndexerConfig(
			config.get('DydxV4.IndexerConfig.httpsEndpoint'),
			config.get('DydxV4.IndexerConfig.wssEndpoint')
		);
	};

	private generateRandomInt32(): number {
		const maxInt32 = 2147483647;
		return Math.floor(Math.random() * (maxInt32 + 1));
	}

	public getOpenedPositions = async (): Promise<PositionData> => {
		const client = this.buildIndexerClient();
		const localWallet = await this.generateLocalWallet();
		if (!localWallet) return;

		return (await client.account.getSubaccountPerpetualPositions(
			localWallet.address,
			0,
			PositionStatus.OPEN
		)) as PositionData;
	};
}
