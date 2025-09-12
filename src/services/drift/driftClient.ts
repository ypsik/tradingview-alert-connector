import { Connection, Keypair, PublicKey  } from '@solana/web3.js';
import * as anchor from '@coral-xyz/anchor';
import { AnchorProvider, Wallet, Program, Idl } from '@coral-xyz/anchor';
import * as drift from '@drift-labs/sdk';
import { CustomUserAccountSubscriber } from './customUserAccountSubscriber';

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

export function keypairFromMnemonic(mnemonic: string): Keypair {
  const seed = bip39.mnemonicToSeedSync(mnemonic);
  const path = `m/44'/501'/0'/0'`; // Phantom Default
  const { key } = derivePath(path, seed.toString('hex'));
  return Keypair.fromSeed(key);
}

export class DriftClient extends AbstractDexClient {
	private readonly env = 'mainnet-beta';
	private client: drift.DriftClient;
	private user: drift.User;
	private subAccountId: number = 0; 
	private readonly wallet: Wallet;
	private readonly logger: CustomLogger;	
	private marketIndexMap: Map<string, drift.PerpMarketAccount> = new Map<string, drift.PerpMarketAccount>();
	private readyPromise: Promise<void>;
	constructor() {
		super();

		this.logger = new CustomLogger('Drift');

		if (
			!process.env.DRIFT_MNEMONIC || !process.env.DRIFT_RPC_SERVER
		) {
			this.logger.warn('Credentials are not set as environment variable'); 
			return;
		}
		const keypair = keypairFromMnemonic(process.env.DRIFT_MNEMONIC);
                this.wallet = new Wallet(keypair);
		
		this.readyPromise = this.initClient();
	}

	private async initClient() 
	{
		try {
			// Initialize Drift SDK          
			const sdkConfig = drift.initialize({ env: this.env });
			const connection = !process.env.DRIFT_RPC_WS ?                          
			                new Connection(process.env.DRIFT_RPC_SERVER) :
					new Connection(process.env.DRIFT_RPC_SERVER, 
					{
						wsEndpoint: process.env.DRIFT_RPC_WS,
						commitment: "confirmed",
					}
			);
			const provider = new AnchorProvider(
		        connection, this.wallet,
			        {
			            preflightCommitment: 'confirmed',
				    skipPreflight: false,
			            commitment: 'confirmed',
			        }
			    );
			const driftPublicKey = new PublicKey(sdkConfig.DRIFT_PROGRAM_ID);
			const rawIndexes = process.env.DRIFT_MARKET_IDS || '';
			const perpMarketIndexes: number[] = rawIndexes
				  .split(',')
				  .map((s) => parseInt(s.trim()))
				  .filter((n) => !isNaN(n));
			const spotMarketIndexes = await this.getUsedSpotMarkets(driftPublicKey, provider);
			await new Promise(resolve => setTimeout(resolve, 2000)); // 1 Sekunde warten


                        const delegateAuthority =  process.env.DRIFT_DELIGATE_ACCOUNT
                            ? new PublicKey(process.env.DRIFT_DELIGATE_ACCOUNT)
                            : undefined;

			this.client = new drift.DriftClient({
			  connection: provider.connection,
			  wallet: provider.wallet,
			  programID: driftPublicKey,
			  perpMarketIndexes: perpMarketIndexes,
			  spotMarketIndexes: spotMarketIndexes,
			  subAccountIds: [this.subAccountId],
			  activeSubAccountId: this.subAccountId,
			  ...(process.env.DRIFT_RPC_WS
			    ? {
			        accountSubscription: {
			          type: "websocket",
			          commitment: "confirmed",
			        },
			      }
			    : {}),
			});
			await this.client.subscribe();	
			await this.client.addUser(this.subAccountId, delegateAuthority);
			await this.client.switchActiveUser(this.subAccountId, delegateAuthority);

			const myUserSubscriber = new CustomUserAccountSubscriber(
			    connection,
			    this.client.program,
			    await this.client.getUserAccountPublicKey(),
			    30_000
			);
			this.user = this.client.getUser(this.subAccountId, delegateAuthority);
//			this.user = new drift.User({
//                                driftClient: this.client,
//                                userAccountPublicKey: await this.client.getUserAccountPublicKey(),
//				accountSubscription: {
//					type: "custom",
//					userAccountSubscriber: myUserSubscriber
//				},
//				authority: delegateAuthority,
//                                includeDelegates: true,
//                            });
//                        await this.user.subscribe();

			await this.user.fetchAccounts();

			const perpMarkets = this.client.getPerpMarketAccounts();
			const spotMarkets = this.client.getSpotMarketAccounts();

			perpMarkets.forEach((market) => {
				const name = Buffer.from(market.name).toString("utf-8").replace(/\0/g, "").trim();
				this.marketIndexMap.set(name, market);
			});
		}
		catch (err) {
			  this.logger.error('initcClient:', err);
		}
	}

	private async getUsedSpotMarkets(driftPublicKey: PublicKey, provider:  AnchorProvider): Promise<number[]> {

			const spotMarketIndexes: number[] = [];
			
                        const bulkAccountLoader = new drift.BulkAccountLoader(
                                provider.connection,
                                'confirmed',
                                1000
                            );

			 
			const delegateAuthority =  process.env.DRIFT_DELIGATE_ACCOUNT
			    ? new PublicKey(process.env.DRIFT_DELIGATE_ACCOUNT)
			    : undefined;
			const client = new drift.DriftClient(
                                {
                                        connection: provider.connection,
                                        wallet: provider.wallet,
                                        programID: driftPublicKey,
                                        perpMarketIndexes: [],
                                        spotMarketIndexes: [],
//                                        accountSubscription: {
//                                                type: "websocket",
//                                                commitment: "confirmed",
//                                        },
					authority: delegateAuthority,       
					includeDelegates: true,  
					
                                }
                        );
			await client.subscribe();
                        await client.addUser(this.subAccountId, delegateAuthority);                        
			await client.switchActiveUser(this.subAccountId, delegateAuthority);
			
			const myUserSubscriber = new CustomUserAccountSubscriber(
                            provider.connection,
                            client.program,
                            await client.getUserAccountPublicKey(),
                            30_000
                        );

                 
			const user = client.getUser(this.subAccountId, delegateAuthority);
//			const user = new drift.User({
//			        driftClient: client,
//			        userAccountPublicKey: await client.getUserAccountPublicKey(),
//				accountSubscription: {
//                                        type: "custom",
//                                        userAccountSubscriber: myUserSubscriber
//                                },
//			    });
//                        await user.subscribe();
			await user.fetchAccounts()

			const userAccount  = user.getUserAccount(); 

			for (const pos of userAccount.spotPositions) {
				const idx = pos.marketIndex;			   
				// Prüfen ob Position aktiv ist (z.B. scaledBalance > 0)
				if (pos.scaledBalance.gt(new drift.BN(0))) {
					spotMarketIndexes.push(idx);
				}
			}		
			spotMarketIndexes.push(0);

			return [...new Set(spotMarketIndexes)];
		
	}

	private async checkSubscriptionHealth() 
	{
	  const isSubscribed = false

	  if (!isSubscribed) {
	    this.logger.warn('Subscription verloren, erneutes Abonnieren...');
	    await this.client.unsubscribe();
	    await this.client.subscribe();
	  } 
	}

	public async getIsAccountReady(): Promise<boolean> {
		await this.readyPromise;
		try {
			// Fetched balance indicates connected wallet
			await this.client.getPerpMarketAccounts();
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
		openedPositions: drift.PerpPosition[],
		mutex: Mutex
	) {
		await this.readyPromise;           

		const orderParams = await this.buildOrderParams(alertMessage);

		const market = orderParams.market;
		const type = OrderType.LIMIT;
		const side = orderParams.side;
		const mode = process.env.DRIFT_MODE || '';
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
		const perpMarketAccount = this.marketIndexMap.get(market);

		if(!perpMarketAccount )
		{
                        this.logger.error(
				`Market ${market} not exists in the map`
                        );
			for (const [name, market] of this.marketIndexMap.entries()) {
			  this.logger.log(`Market: ${name} | Index: ${market.marketIndex}`);
			}
		}

		if (
			(side === OrderSide.SELL && direction === 'long') ||
			(side === OrderSide.BUY && direction === 'short')
		) {
			// Drift  group all positions in one position per symbol
			const position = openedPositions.find((el) =>  el.marketIndex === perpMarketAccount.marketIndex);

			if (!position) {
				this.logger.log('order is ignored because position not exists');
				return;
			}
			const baseAmount = drift.convertToNumber(position.baseAssetAmount, drift.BASE_PRECISION);			
			const quoteAssetAmount = Math.abs(drift.convertToNumber(position.quoteAssetAmount, drift.QUOTE_PRECISION));
			this.logger.log(`position baseAmount ${baseAmount},  quoteAssetAmount ${quoteAssetAmount}`);
			
			const profit = calculateProfit(orderParams.price, quoteAssetAmount/baseAmount);

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

			const sum = Math.abs(baseAmount);

			size =
				orderMode === 'full' || newPositionSize == 0
					? sum
					: Math.min(size, sum);
		} else if (orderMode === 'full' || newPositionSize == 0) {
			const position = openedPositions.find((el) => el.marketIndex === perpMarketAccount.marketIndex);
			const baseAmount = drift.convertToNumber(position.baseAssetAmount, drift.BASE_PRECISION);

			if (!position) {
				if (newPositionSize == 0) {
					this.logger.log(
						'ignore this order because new position size is 0 and current position not exists'
					);
					return;
				}
			} else {
				if (
					(side === OrderSide.SELL && baseAmount > 0) ||
					(side === OrderSide.BUY && baseAmount < 0)
				)
					size = Math.abs(baseAmount);
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
			const orderStepSize = perpMarketAccount.amm.orderStepSize; // z.B. 100000
			const rawBaseAssetAmount = new drift.BN(size * drift.BASE_PRECISION.toNumber());
			const baseAssetAmount = rawBaseAssetAmount.div(orderStepSize).mul(orderStepSize);
			
                        const params ={
                          marketIndex: perpMarketAccount.marketIndex,
                          direction: side == OrderSide.SELL ? drift.PositionDirection.SHORT : drift.PositionDirection.LONG,
                          baseAssetAmount: baseAssetAmount,
                          orderType: drift.OrderType.LIMIT, 
			  price: new drift.BN(price * drift.PRICE_PRECISION.toNumber()),
			  postOnly: drift.PostOnlyParams.NONE, 
                        };
		
			const txSig = await this.client.placePerpOrder(params);
			const confirmation = await this.client.connection.confirmTransaction(txSig, "confirmed");
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

	private isOrderFilled = async (
		orderId: string,
		market: string,
		params: { user?: string }
	): Promise<boolean> => {
//		const order = await this.client.fetchOrder(orderId, market, params);

//		this.logger.log('Order ID: ', order.id);

//		return order.status == 'closed';
		return true;
	};

	public getOpenedPositions = async (): Promise<drift.PerpPosition[]> =>
	{
		await this.readyPromise;
		const userAccount = this.client.getUserAccount(this.subAccountId);
		const perpPositions = userAccount.perpPositions;
		return perpPositions.filter(p => !p.baseAssetAmount.isZero());
	};
}
