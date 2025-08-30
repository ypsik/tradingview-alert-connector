export type PositionSide = "long" | "short";

export interface OpenPosition {
  market: string;                // Markt-Symbol oder Market-ID
  size: number;                  // Positionsgröße
  side: "long" | "short";        // Richtung der Position
  margin: string;                // Eingesetztes Margin
  entry_price?: string;           // Eröffnungs-Preis
  leverage?: string;             // Hebel
  unrealized_pnl?: string;       // Unrealisierter Gewinn/Verlust
  liquidation_price?: string;    // Liquidationspreis
  position_id?: string;          // ID der Position
  open_timestamp?: number;       // Eröffnungszeit (Unix)
  fee_paid?: string;             // Bereits gezahlte Fees
  unrealized_funding?: string;   // Unrealisierte Funding-Kosten
  cumulative_funding?: string;   // Kumulierte Funding-Kosten
}

export interface PositionsByAccountResponse {
  positions: OpenPosition[];
}
