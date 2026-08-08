# tonkas

On-chain contracts for a Telegram mining game built around a frog-themed meme
token on TON — slot purchases, tiered skip NFTs, a buyback-and-lock router,
and a reward vault with a halving emission schedule.

See `docs/architecture.md` for the full contract design and
`docs/tokenomics.md` for the current token/liquidity state and migration plan.

## Project structure

-   `contracts` - source code of all the smart contracts of the project and their dependencies.
-   `wrappers` - wrapper classes (implementing `Contract` from ton-core) for the contracts, including any [de]serialization primitives and compilation functions.
-   `tests` - tests for the contracts.
-   `scripts` - scripts used by the project, mainly the deployment scripts.

## How to use

### Build

`npx blueprint build` or `yarn blueprint build`

### Test

`npx blueprint test` or `yarn blueprint test`

### Deploy or run another script

`npx blueprint run` or `yarn blueprint run`

### Add a new contract

`npx blueprint create ContractName` or `yarn blueprint create ContractName`
