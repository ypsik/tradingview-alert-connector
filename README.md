# dydx-tradingview-integration

dYdX Tradingview Integration is a free and noncustodial tool for you to Integrate tradingView strategy alert and execute automated trading for dYdX.

# Tutorial

https://dydx-tv.gitbook.io/

# Video Tutorial

TBA

# Prerequisites

- TradingView Account at least Pro plan

https://www.tradingview.com/gopro/

- dYdX trading account with collateral already in place

https://dydx.exchange/

# Installation

```bash
git clone https://github.com/junta/dydx-tradingview-integration
cd dydx-tradingview-integration
npm install
```

# Quick Start

- rename .env.sample to .env
- fill environment variables in .env (see full tutorial)

### with Docker

```bash
docker-compose build
docker-compose up -d
```

### without Docker

```bash
yarn start
```

## Disclaimer

This project is hosted under an MIT OpenSource License. Neither the dYdX Trading Inc nor any dYdX affiliated company, are liable for any consequences associated with running this software. This tool does not guarantee users’ future profit and users have to use this tool by their own responsibility.This is an experimental product, and users should practice caution when using it.
