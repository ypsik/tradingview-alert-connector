import {
	PositionStatus,
	OrderSide as v4OrderSide
} from '@dydxprotocol/v4-client-js';

export type AlertObject = {
	exchange: string;
	strategy: string;
	market: string;
	size?: number;
	sizeUsd?: number;
	sizeByLeverage?: number;
	order: string;
	price: number;
	reverse: boolean;
	passphrase?: string;
	collateral?: string;
	slippagePercentage?: string;
	orderMode?: '' | 'full';
	newPositionSize: number;
	direction?: 'long' | 'short';
	minProfit?: number;
};

export type dydxV4OrderParams = {
	market: string;
	side: v4OrderSide;
	size: number;
	price: number;
};
export interface OrderResult {
	size: number;
	side: string;
	orderId: string;
}

export interface MarketData {
	market: string;
	status: PositionStatus;
	side: string;
	size: number;
	maxSize: string;
	entryPrice: number;
	exitPrice: string | null;
	realizedPnl: string;
	unrealizedPnl: string;
	createdAt: string;
	createdAtHeight: string;
	closedAt: string | null;
	sumOpen: string;
	sumClose: string;
	netFunding: string;
	subaccountNumber: number;
}

export interface PositionData {
	positions: MarketData[];
}
