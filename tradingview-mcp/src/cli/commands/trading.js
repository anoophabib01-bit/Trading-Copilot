import { register } from '../router.js';
import * as core from '../../core/trading.js';

register('trading', {
  description: 'Live broker account tools (positions, orders, account)',
  subcommands: new Map([
    ['positions', {
      description: 'Get open positions from the connected broker account',
      handler: () => core.getPositions(),
    }],
    ['orders', {
      description: 'Get orders from the connected broker account (--status to filter)',
      handler: (opts) => core.getOrders({ status: opts.status }),
    }],
    ['summary', {
      description: 'Get account balance, equity, and P&L',
      handler: () => core.getAccountSummary(),
    }],
    ['account', {
      description: 'Get everything: summary, positions, and orders in one call',
      handler: () => core.getAccount(),
    }],
    ['place-market', {
      description: 'PLACES A REAL MARKET ORDER. Usage: tv trading place-market --side buy --qty 1 [--symbol MNQU6]',
      handler: (opts) => core.placeMarketOrder({ side: opts.side, qty: Number(opts.qty), symbol: opts.symbol }),
    }],
  ]),
});
