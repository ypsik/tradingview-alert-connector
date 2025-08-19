export interface Position {
  symbol: string;
  positionSide: "LONG" | "SHORT";
  entryPrice: number;
  markPrice: number;
  positionAmt: number;
  leverage: number;
  unrealizedProfit: number;
  marginType: "ISOLATED" | "CROSS";
  isolatedMargin?: number;
  updateTime: number;
}
