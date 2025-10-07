import express, { Router } from 'express';
import { validateAlert } from '../services';
import { DexRegistry } from '../services/dexRegistry';
import { CronJob } from 'cron';
import { MarketData } from '../types';
import * as fs from 'fs';
import type { Position } from 'ccxt';
import {
  PerpPosition
} from '@drift-labs/sdk';
import * as nexo  from '../nexo';
import * as aster  from '../aster';
import * as mars  from '../mars';
import * as lighter from 'lighter-ts-sdk/dist/api/account-api';
import { Mutex } from 'async-mutex';
import { CustomLogger } from '../services/logger/logger.service';
import { shouldProcessAlert } from '../utils/dedupe';

const logger = new CustomLogger('Controller');

const router: Router = express.Router();
const staticDexRegistry = new DexRegistry();
const dydxv4Client = staticDexRegistry.getDex('dydxv4');
const hyperliquidClient = staticDexRegistry.getDex('hyperliquid');
const bybitClient = staticDexRegistry.getDex('bybit');
const bitgetClient = staticDexRegistry.getDex('bitget');
const bingxClient = staticDexRegistry.getDex('bingx');
const krakenClient = staticDexRegistry.getDex('kraken');
const nexoClient = staticDexRegistry.getDex('nexo');
const driftClient = staticDexRegistry.getDex('drift');
const asterClient = staticDexRegistry.getDex('aster');
const marsClient = staticDexRegistry.getDex('mars');
const apexClient = staticDexRegistry.getDex('apex');
const lighterClient = staticDexRegistry.getDex('lighter');

let openedPositionsDydxv4: MarketData[] = [];
let openedPositionsHyperliquid: Position[] = [];
let openedPositionsBybit: Position[] = [];
let openedPositionsBitget: Position[] = [];
let openedPositionsBingx: Position[] = [];
let openedPositionsKraken: Position[] = [];
let openedPositionsNexo: nexo.FuturesPosition[] = [];
let openedPositionsDrift: PerpPosition[] = [];
let openedPositionsAster: aster.Position[] = [];
let openedPositionsMars: mars.OpenPosition[] = [];
let openedPositionsApex: Position[] = [];
let openedPositionsLighter: lighter.AccountPosition[] = [];

const mutexDydxv4 = new Mutex();
const mutexHyperliquid = new Mutex();
const mutexBybit = new Mutex();
const mutexBitget = new Mutex();
const mutexBingx = new Mutex();
const mutexKraken = new Mutex();
const mutexNexo = new Mutex();
const mutexDrift = new Mutex();
const mutexAster = new Mutex();
const mutexMars = new Mutex();
const mutexApex = new Mutex();
const mutexLighter = new Mutex();

type SupportedExchanges =
	| 'Dydxv4'
	| 'Hyperliquid'
	| 'Bybit'
	| 'Bitget'
	| 'Bingx'
	| 'Kraken'
	| 'Nexo' 
	| 'Aster'
	| 'Drift'
	| 'Mars'
	| 'Apex'
	| 'Lighter';

function writeNewEntries({
	exchange,
	positions
}: {
	exchange: SupportedExchanges;
	positions: MarketData[] | Position[] | nexo.FuturesPosition[] | PerpPosition[] | aster.Position[] | mars.OpenPosition[] | lighter.AccountPosition[];
}) {
	const folderPath = './data/custom/exports/';
	if (!fs.existsSync(folderPath)) {
		fs.mkdirSync(folderPath, { recursive: true });
	}

	const fullPath = folderPath + `/positions${exchange}.csv`;

	// Header
	const headerString =
		'market,status,side,size,maxSize,entryPrice,exitPrice,createdAt,createdAtHeight,closedAt,sumOpen,sumClose,netFunding,subaccountNumber';

	const newRecords: string[][] = [];

	for (const position of positions) {
		let record: string[];

		if (exchange === 'Dydxv4') {
			const typedPosition = position as MarketData;
			record = [
				typedPosition.market || '',
				typedPosition.status || '',
				typedPosition.side || '',
				(typedPosition.size || 0).toString(),
				typedPosition.maxSize || '',
				(typedPosition.entryPrice || 0).toString(),
				typedPosition.exitPrice || '',
				typedPosition.createdAt || '',
				typedPosition.createdAtHeight || '',
				typedPosition.closedAt || '',
				typedPosition.sumOpen || '',
				typedPosition.sumClose || '',
				typedPosition.netFunding || '',
				typedPosition.subaccountNumber?.toString() || ''
			];
		} else if (exchange === 'Aster') {
			const typedPosition = position as aster.Position;
			record = [
				typedPosition.symbol || '',
				'OPEN',
				typedPosition.positionSide || '',
				typedPosition.positionAmt?.toString() || '',
				typedPosition.leverage?.toString() || '',
				typedPosition.entryPrice?.toString() || '',
				typedPosition.markPrice?.toString() || '',
				'',
				typedPosition.updateTime?.toString() || '',
				'',
				typedPosition.unrealizedProfit?.toString() || '',
				typedPosition.marginType || '',
				typedPosition.isolatedMargin?.toString() || '',
				''
			];
		} else {
			const typedPosition = position as Position;
			record = [
				typedPosition.symbol || '',
				'OPEN',
				typedPosition.side || '',
				typedPosition.contracts?.toString() || '',
				'',
				typedPosition.entryPrice?.toString() || '',
				'',
				'',
				'',
				'',
				'',
				'',
				'',
				''
			];
		}

		newRecords.push(record);
	}

	// Alle Zeilen zusammenfügen: Header + Records
	const allData = [headerString, ...newRecords.map(r => r.join(','))].join('\n');

	// Überschreiben statt anhängen
	fs.writeFileSync(fullPath, allData, 'utf-8');
}
	
const getExchangeVariables = (exchange: string) => {
	switch (exchange) {
		case 'dydxv4':
			return {
				openedPositions: openedPositionsDydxv4,
				mutex: mutexDydxv4
			};
		case 'hyperliquid':
			return {
				openedPositions: openedPositionsHyperliquid,
				mutex: mutexHyperliquid
			};
		case 'bybit':
			return {
				openedPositions: openedPositionsBybit,
				mutex: mutexBybit
			};
		case 'bitget':
			return {
				openedPositions: openedPositionsBitget,
				mutex: mutexBitget
			};
		case 'bingx':
			return {
				openedPositions: openedPositionsBingx,
				mutex: mutexBingx
			};
		case 'kraken':
                        return {
                                openedPositions: openedPositionsKraken,
                                mutex: mutexKraken
                        };
		 case 'nexo':
                        return {
                                openedPositions: openedPositionsNexo,
                                mutex: mutexNexo
                        };
		 case 'aster':
                        return {
                                openedPositions: openedPositionsAster,
                                mutex: mutexAster
                        };
                 case 'drift':
                        return {
                                openedPositions: openedPositionsDrift,
                                mutex: mutexDrift
                        };
                 case 'mars':
                        return {
                                openedPositions: openedPositionsMars,
                                mutex: mutexMars
			};
		 case 'apex':
                        return {
                                openedPositions: openedPositionsApex,
                                mutex: mutexApex
                        };
                 case 'lighter':
                        return {
                                openedPositions: openedPositionsLighter,
                                mutex: mutexLighter                       
                        };

	}
};

const dydxv4Updater = async () => {
	try {
                if (!process.env.DYDX_V4_MNEMONIC) {
                        return;
                }

		const { positions: dydxv4Positions } =
			await dydxv4Client.getOpenedPositions();
		openedPositionsDydxv4 = dydxv4Positions as unknown as MarketData[];
		writeNewEntries({
			exchange: 'Dydxv4',
			positions: openedPositionsDydxv4
		});
	} catch {
		logger.warn(`Dydxv4 is not working. Time: ${new Date()}`);
	}
};

const hyperLiquidUpdater = async () => {
	try {
                if (
                        !process.env.HYPERLIQUID_PRIVATE_KEY ||
                        !process.env.HYPERLIQUID_WALLET_ADDRESS
                ) {
                        return;
                }

		const hyperliquidPositions = await hyperliquidClient.getOpenedPositions();
		openedPositionsHyperliquid = hyperliquidPositions as unknown as Position[];
		writeNewEntries({
			exchange: 'Hyperliquid',
			positions: openedPositionsHyperliquid
		});
	} catch {
		logger.warn(`Hyperliquid is not working. Time: ${new Date()}`);
	}
};

const apexUpdater = async () => {
        try {
		if (
                        !process.env.APEX_API_KEY ||
                        !process.env.APEX_API_SECRET ||
                        !process.env.APEX_API_PASSWORD ||
                        !process.env.APEX_OMNI_KEY_SEED
                ) {
                        return;
                }

                const apexPositions = await apexClient.getOpenedPositions();
                openedPositionsApex = apexPositions as unknown as Position[];
                writeNewEntries({
                        exchange: 'Apex',
                        positions: openedPositionsApex
                });
        } catch(ex) {
                logger.warn(`Apex is not working. Time: ${new Date()}`, ex);
        }
};

const bybitUpdater = async () => {
	try {
                if (!process.env.BYBIT_API_KEY || !process.env.BYBIT_SECRET) {
                        return;
                }

		const bybitPositions = await bybitClient.getOpenedPositions();
		openedPositionsBybit = bybitPositions as unknown as Position[];
		writeNewEntries({
			exchange: 'Bybit',
			positions: openedPositionsBybit
		});
	} catch(ex) {
		logger.warn(`Bybit is not working. Time: ${new Date()}`, ex);
	}
};

const bitgetUpdater = async () => {
	try {
                if (
                        !process.env.BITGET_API_KEY ||
                        !process.env.BITGET_SECRET ||
                        !process.env.BITGET_API_PASSWORD
                ) {
                        return;
                }

		const bitgetPositions = await bitgetClient.getOpenedPositions();
		openedPositionsBitget = bitgetPositions as unknown as Position[];
		writeNewEntries({
			exchange: 'Bitget',
			positions: openedPositionsBitget
		});
	} catch {
		logger.warn(`Bitget is not working. Time: ${new Date()}`);
	}
};

const bingxUpdater = async () => {
	try {

                if (!process.env.BINGX_API_KEY || !process.env.BINGX_SECRET) {
                        return;
                }

		const bingxPositions = await bingxClient.getOpenedPositions();
		openedPositionsBingx = bingxPositions as unknown as Position[];
		writeNewEntries({
			exchange: 'Bingx',
			positions: openedPositionsBingx
		});
	} catch(ex) {
		logger.warn(`Bingx is not working. Time: ${new Date()}`, ex);
	}
};

const krakenUpdater = async () => {
        try {
                if (!process.env.KRAKEN_FUTURES_API_KEY || !process.env.KRAKEN_FUTURES_API_SECRET) {
                        return;
                }

                const krakenPositions = await krakenClient.getOpenedPositions();
                openedPositionsKraken = krakenPositions as unknown as Position[];
                writeNewEntries({
                        exchange: 'Kraken',
                        positions: openedPositionsKraken
                });
        } catch(ex) {
                logger.warn(`Kraken is not working. Time: ${new Date()}`, ex);
        }
};

const nexoUpdater = async () => {
        try {
		
                if (!process.env.NEXO_API_KEY || !process.env.NEXO_API_SECRET) {                      
                        return;
                }

                const nexoPositions = await nexoClient.getOpenedPositions();
                openedPositionsNexo = nexoPositions as unknown as nexo.FuturesPosition[];
                writeNewEntries({
                        exchange: 'Nexo',
                        positions: openedPositionsNexo
                });
        } catch(ex) {
                logger.warn(`Nexo is not working. Time: ${new Date()}`, ex);
        }
};

const asterUpdater = async () => {
        try {

                if (!process.env.ASTER_API_KEY || !process.env.ASTER_API_SECRET) {
                        return;
                }

                const asterPositions = await asterClient.getOpenedPositions();
                openedPositionsAster = asterPositions as unknown as aster.Position[];
                writeNewEntries({
                        exchange: 'Aster',
                        positions: openedPositionsAster
                });
        } catch(ex) {
                logger.warn(`Aster is not working. Time: ${new Date()}`, ex);
        }
};

const driftUpdater = async () => {
        try {
                if (
                        !process.env.DRIFT_MNEMONIC || !process.env.DRIFT_RPC_SERVER
                ) {
                        return;
                }

		const driftPositions = await driftClient.getOpenedPositions();

                openedPositionsDrift = driftPositions as unknown as PerpPosition[];
                writeNewEntries({
                        exchange: 'Drift',
                        positions: openedPositionsDrift
                });
        } catch(ex) {
                logger.warn(`Drift is not working. Time: ${new Date()}`, ex);
        }
};

const marsUpdater = async () => {
        try {
                if (
                        !process.env.MARS_MNEMONIC || !process.env.MARS_RPC_SERVER
                ) {
                        return;
                }

                const marsPositions = await marsClient.getOpenedPositions();

                openedPositionsMars = marsPositions as unknown as mars.OpenPosition[];
                writeNewEntries({
                        exchange: 'Mars',
                        positions: openedPositionsMars
                });
        } catch(ex) {
                logger.warn(`Mars is not working. Time: ${new Date()}`, ex);
        }
};


const lighterUpdater = async () => {
        try {
                if (!process.env.LIGHTER_API_KEY || !process.env.LIGHTER_API_SECRET ||
                    !process.env.LIGHTER_ACCOUNT_INDEX || !process.env.LIGHTER_API_KEY_INDEX) {                   
                        return;
                }

                const lighterPositions = await lighterClient.getOpenedPositions();

                openedPositionsLighter = lighterPositions as unknown as lighter.AccountPosition[];
                writeNewEntries({
                        exchange: 'Lighter',
                        positions: openedPositionsLighter
                });
        } catch(ex) {
                logger.warn(`Lighter is not working. Time: ${new Date()}`, ex);
        }
};



CronJob.from({
	cronTime: process.env.UPDATE_POSITIONS_TIMER || '*/30 * * * * *', // Every 30 seconds
	onTick: async () => {
		await Promise.all([
			dydxv4Updater(),
			hyperLiquidUpdater(),
			bybitUpdater(),
			bitgetUpdater(),
			bingxUpdater(),
			krakenUpdater(),
			nexoUpdater(),
			driftUpdater(),
			asterUpdater(),
			marsUpdater(),
			apexUpdater(),
			lighterUpdater()
		]);
	},
	runOnInit: true,
	start: true
});

router.get('/', async (req, res) => {
	res.send('OK');
});

router.get('/accounts', async (req, res) => {
	logger.log('Received GET request.');

	const dexNames = ['dydxv4', 'hyperliquid', 'bybit', 'bitget', 'bingx', 'kraken', 'nexo', 'drift', 'aster', 'mars', 'apex', 'lighter'];
	const dexClients = dexNames.map((name) => staticDexRegistry.getDex(name));

	try {
		const accountStatuses = await Promise.all(
			dexClients.map((client) => client.getIsAccountReady())
		);

		const message = {
			dYdX_v4: accountStatuses[0], // dydxv4
			HyperLiquid: accountStatuses[1], // hyperliquid
			Bybit: accountStatuses[2], // bybit
			Bitget: accountStatuses[3], // bitget
			Bingx: accountStatuses[4], // bingx
			Kraken: accountStatuses[5], // kraken
			Nexo: accountStatuses[6], // nexo
			Drift: accountStatuses[7], // drift
			Aster: accountStatuses[8], // aster
			Mars: accountStatuses[9], // mars
			Apex: accountStatuses[10], // apex
			Lighter:  accountStatuses[11], // lighter
			
		};
		res.send(message);
	} catch (error) {
		logger.error('Failed to get account readiness:', error);
		res.status(500).send('Internal server error');
	}
});

router.post('/', async (req, res) => {
	logger.log('Recieved Tradingview strategy alert:', req.body);

	const validated = await validateAlert(req.body);
	if (!validated) {
		res.send('Error. alert message is not valid');
		return;
	}

	// set dydxv3 by default for backwards compatibility
	const exchange = req.body['exchange']?.toLowerCase() || 'dydxv3';

	const dexClient = staticDexRegistry.getDex(exchange);

	if (!dexClient) {
		res.send(`Error. Exchange: ${exchange} is not supported`);
		return;
	}

	// 🔒 Dedupe-Check: blockt doppelte Alerts innerhalb von 5 Sekunden
	if (!shouldProcessAlert(req.body)) {
		logger.log('⚠️ Duplicate alert ignored:', req.body);
		res.send('Duplicate alert ignored');
		return;
	}
	
	// TODO: add check if dex client isReady

	try {
		const { openedPositions, mutex } = getExchangeVariables(exchange);
		await dexClient.placeOrder(req.body, openedPositions, mutex);

		res.send('OK');
		// checkAfterPosition(req.body);
	} catch (e) {
		res.send('error');
	}
});

// router.get('/debug-sentry', function mainHandler(req, res) {
//	throw new Error('My first Sentry error!');
// });

export default router;
