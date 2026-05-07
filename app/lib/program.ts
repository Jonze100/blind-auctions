import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import {
  getCompDefAccAddress,
  getCompDefAccOffset,
  getComputationAccAddress,
  getClusterAccAddress,
  getMXEAccAddress,
  getMempoolAccAddress,
  getExecutingPoolAccAddress,
} from "@arcium-hq/client";

export const PROGRAM_ID = new PublicKey(
  "GLB8HNet6sGBBDLs6QW3sFFNxdLfKMUHSFAxpe9JWs6u"
);
export const CLUSTER_URL = "https://api.devnet.solana.com";
export const ARCIUM_CLUSTER_OFFSET = 456; // devnet

export const AUCTION_TYPES = ["Sealed-Bid", "Vickrey", "Uniform"] as const;
export type AuctionType = (typeof AUCTION_TYPES)[number];

export function getAuctionPDA(creatorPubkey: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("auction"), creatorPubkey.toBuffer()],
    PROGRAM_ID
  );
  return pda;
}

function getCompDef(name: string): PublicKey {
  return getCompDefAccAddress(
    PROGRAM_ID,
    Buffer.from(getCompDefAccOffset(name)).readUInt32LE()
  );
}

export function getBaseAccounts(computationOffset: BN) {
  return {
    computationAccount: getComputationAccAddress(
      ARCIUM_CLUSTER_OFFSET,
      computationOffset
    ),
    clusterAccount: getClusterAccAddress(ARCIUM_CLUSTER_OFFSET),
    mxeAccount: getMXEAccAddress(PROGRAM_ID),
    mempoolAccount: getMempoolAccAddress(ARCIUM_CLUSTER_OFFSET),
    executingPool: getExecutingPoolAccAddress(ARCIUM_CLUSTER_OFFSET),
  };
}

export const COMP_DEFS = {
  submit_bid: getCompDef("submit_bid"),
  find_winner_sealed: getCompDef("find_winner_sealed"),
  find_winner_vickrey: getCompDef("find_winner_vickrey"),
  find_clearing_price: getCompDef("find_clearing_price"),
};
