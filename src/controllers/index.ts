import express, { Router } from 'express';
import { validateAlert } from '../services';
import { DexRegistry } from '../services/dexRegistry';
import { CronJob } from 'cron';
import { MarketData } from '../types';
import * as fs from 'fs';
import type { Position } from 'ccxt';
import * as nexo  from '../nexo';
import { Mutex } from 'async-mutex';
import { CustomLogger } from '../services/logger/logger.service';

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


let openedPositionsDydxv4: MarketData[] = [];
let openedPositionsHyperliquid: Position[] = [];
let openedPositionsBybit: Position[] = [];
let openedPositionsBitget: Position[] = [];
let openedPositionsBingx: Position[] = [];
let openedPositionsKraken: Position[] = [];
let openedPositionsNexo: nexo.FuturesPosition[] = [];


const mutexDydxv4 = new Mutex();
const mutexHyperliquid = new Mutex();
const mutexBybit = new Mutex();
const mutexBitget = new Mutex();
const mutexBingx = new Mutex();
const mutexKraken = new Mutex();
const mutexNexo = new Mutex()

type SupportedExchanges =
	| 'Dydxv4'
	| 'Hyperliquid'
	| 'Bybit'
	| 'Bitget'
	| 'Bingx'
	| 'Kraken'
	| 'Nexo';


function writeNewEntries({
	exchange,
	positions
}: {
	exchange: SupportedExchanges;
	positions: MarketData[] | Position[] | nexo.FuturesPosition[];
}) {
	const folderPath = './data/custom/exports/';
	if (!fs.existsSync(folderPath)) {
		fs.mkdirSync(folderPath, {
			recursive: true
		});
	}

	const fullPath = folderPath + `/positions${exchange}.csv`;
	if (!fs.existsSync(fullPath)) {
		const headerString =
			'market,status,side,size,maxSize,entryPrice,exitPrice,createdAt,createdAtHeight,closedAt,sumOpen,sumClose,netFunding,subaccountNumber';
		fs.writeFileSync(fullPath, headerString);
	}

	const records = fs.readFileSync(fullPath).toString('utf-8').split('\n');

	const newRecords = [];

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

		if (
			records.includes(record.toString()) ||
			records.includes(`${record.toString()},`)
		)
			continue;

		newRecords.push(record);
	}

	const appendString = newRecords.map((record) => `\n${record.join()}`).join();

	fs.appendFileSync(fullPath, appendString);
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
	}
};

const dydxv4Updater = async () => {
	try {
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

const bybitUpdater = async () => {
	try {
		const bybitPositions = await bybitClient.getOpenedPositions();
		openedPositionsBybit = bybitPositions as unknown as Position[];
		writeNewEntries({
			exchange: 'Bybit',
			positions: openedPositionsBybit
		});
	} catch {
		logger.warn(`Bybit is not working. Time: ${new Date()}`);
	}
};

const bitgetUpdater = async () => {
	try {
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
		const bingxPositions = await bingxClient.getOpenedPositions();
		openedPositionsBingx = bingxPositions as unknown as Position[];
		writeNewEntries({
			exchange: 'Bingx',
			positions: openedPositionsBingx
		});
	} catch {
		logger.warn(`Bingx is not working. Time: ${new Date()}`);
	}
};

const krakenUpdater = async () => {
        try {
                const krakenPositions = await krakenClient.getOpenedPositions();
                openedPositionsKraken = krakenPositions as unknown as Position[];
                writeNewEntries({
                        exchange: 'Kraken',
                        positions: openedPositionsKraken
                });
        } catch {
                logger.warn(`Kraken is not working. Time: ${new Date()}`);
        }
};

const nexoUpdater = async () => {
        try {
                const nexoPositions = await nexoClient.getOpenedPositions();
                openedPositionsNexo = nexoPositions as unknown as nexo.FuturesPosition[];
                writeNewEntries({
                        exchange: 'Nexo',
                        positions: openedPositionsNexo
                });
        } catch(ex) {
                logger.warn(`Nexo is not working. Time: ${new Date()}`,ex);
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
			nexoUpdater()
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

	const dexRegistry = new DexRegistry();
	const dexNames = ['dydxv4', 'hyperliquid', 'bybit', 'bitget', 'bingx', 'kraken', 'nexo'];
	const dexClients = dexNames.map((name) => dexRegistry.getDex(name));

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
			Nexo: accountStatuses[6] // nexo
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

	const dexClient = new DexRegistry().getDex(exchange);

	if (!dexClient) {
		res.send(`Error. Exchange: ${exchange} is not supported`);
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
