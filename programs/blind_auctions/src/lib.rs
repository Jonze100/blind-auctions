use anchor_lang::prelude::*;
use arcium_anchor::prelude::*;
use arcium_client::idl::arcium::types::CallbackAccount;

const COMP_DEF_OFFSET_SUBMIT_BID: u32 = comp_def_offset("submit_bid");
const COMP_DEF_OFFSET_FIND_WINNER_SEALED: u32 = comp_def_offset("find_winner_sealed");
const COMP_DEF_OFFSET_FIND_WINNER_VICKREY: u32 = comp_def_offset("find_winner_vickrey");
const COMP_DEF_OFFSET_FIND_CLEARING_PRICE: u32 = comp_def_offset("find_clearing_price");

// 4 bids × 3 fields + 1 count = 13 ciphertexts, each 32 bytes
const BOOK_CT_COUNT: usize = 13;
const BOOK_CT_BYTES: usize = BOOK_CT_COUNT * 32; // 416

declare_id!("GLB8HNet6sGBBDLs6QW3sFFNxdLfKMUHSFAxpe9JWs6u");

// Zero-copy account: memory-mapped directly from account data, no borsh deserialization.
// All fields must be bytemuck::Pod; u128 replaced with [u8;16] to dodge alignment requirements.
// Explicit _pad0 covers the implicit padding that repr(C) would otherwise leave uninit.
#[account(zero_copy)]
pub struct AuctionState {
    pub creator: [u8; 32],
    pub auction_type: u8,
    pub _pad0: [u8; 7],
    pub slots: u64,
    pub bid_count: u64,
    pub book_pub_key: [u8; 32],
    pub book_nonce: [u8; 16],
    pub book_ciphertexts: [u8; BOOK_CT_BYTES],
}

// 8-byte Anchor discriminator + struct body
const AUCTION_STATE_SPACE: usize = 8 + core::mem::size_of::<AuctionState>();

// Zero-sized proxy for SignedComputationOutputs so the enum's
// MarkerForIdlBuildDoNotUseThis variant stays 0 bytes instead of 464.
// SIZE = 464 tells the arcium deserializer how many bytes to read.
// SharedEncryptedStruct<13>: 32 (enc_key) + 16 (nonce) + 13*32 (cts) = 464
#[derive(AnchorSerialize, AnchorDeserialize)]
struct BidBookEncProxy;
impl arcium_anchor::HasSize for BidBookEncProxy {
    const SIZE: usize = 464;
}

#[arcium_program]
pub mod blind_auctions {
    use super::*;

    // ─── Init comp defs ──────────────────────────────────────────────────────

    pub fn init_submit_bid_comp_def(ctx: Context<InitSubmitBidCompDef>) -> Result<()> {
        init_comp_def(ctx.accounts, None, None)
    }

    pub fn init_find_winner_sealed_comp_def(
        ctx: Context<InitFindWinnerSealedCompDef>,
    ) -> Result<()> {
        init_comp_def(ctx.accounts, None, None)
    }

    pub fn init_find_winner_vickrey_comp_def(
        ctx: Context<InitFindWinnerVickreyCompDef>,
    ) -> Result<()> {
        init_comp_def(ctx.accounts, None, None)
    }

    pub fn init_find_clearing_price_comp_def(
        ctx: Context<InitFindClearingPriceCompDef>,
    ) -> Result<()> {
        init_comp_def(ctx.accounts, None, None)
    }

    // ─── Create Auction ───────────────────────────────────────────────────────

    pub fn create_auction(
        ctx: Context<CreateAuction>,
        auction_type: u8,
        slots: u64,
        book_pub_key: [u8; 32],
        book_nonce: u128,
    ) -> Result<()> {
        let mut state = ctx.accounts.auction_state.load_init()?;
        state.creator = ctx.accounts.creator.key().to_bytes();
        state.auction_type = auction_type;
        state.slots = slots;
        state.bid_count = 0;
        state.book_pub_key = book_pub_key;
        state.book_nonce = book_nonce.to_le_bytes();
        // book_ciphertexts zero-initialized by Solana account creation
        Ok(())
    }

    // ─── Submit Bid ───────────────────────────────────────────────────────────

    pub fn submit_bid(
        ctx: Context<SubmitBid>,
        computation_offset: u64,
        bid_amount_ct: [u8; 32],
        bid_lo_ct: [u8; 32],
        bid_hi_ct: [u8; 32],
        bid_pub_key: [u8; 32],
        bid_nonce: u128,
    ) -> Result<()> {
        let state = ctx.accounts.auction_state.load()?;
        let book_pub_key = state.book_pub_key;
        let book_nonce = u128::from_le_bytes(state.book_nonce);
        let bid_count = state.bid_count;

        let mut args = ArgBuilder::new()
            .x25519_pubkey(bid_pub_key)
            .plaintext_u128(bid_nonce)
            .encrypted_u64(bid_amount_ct)
            .encrypted_u128(bid_lo_ct)
            .encrypted_u128(bid_hi_ct)
            .x25519_pubkey(book_pub_key)
            .plaintext_u128(book_nonce);

        for i in 0..4usize {
            let base = i * 3;
            let mut amount_ct = [0u8; 32];
            let mut lo_ct = [0u8; 32];
            let mut hi_ct = [0u8; 32];
            amount_ct.copy_from_slice(&state.book_ciphertexts[base * 32..(base + 1) * 32]);
            lo_ct.copy_from_slice(&state.book_ciphertexts[(base + 1) * 32..(base + 2) * 32]);
            hi_ct.copy_from_slice(&state.book_ciphertexts[(base + 2) * 32..(base + 3) * 32]);
            args = args
                .encrypted_u64(amount_ct)
                .encrypted_u128(lo_ct)
                .encrypted_u128(hi_ct);
        }
        let mut count_ct = [0u8; 32];
        count_ct.copy_from_slice(&state.book_ciphertexts[12 * 32..]);
        // bid_count is passed as plaintext so the circuit knows the correct insertion
        // index without relying on book.count (garbage from zero-initialized ciphertexts).
        let args = args.encrypted_u64(count_ct).plaintext_u64(bid_count).build();
        // drop state borrow before mutable ctx use
        drop(state);

        let auction_state_key = ctx.accounts.auction_state.key();
        let callback_ix = SubmitBidCallback::callback_ix(
            computation_offset,
            &ctx.accounts.mxe_account,
            &[CallbackAccount {
                pubkey: auction_state_key,
                is_writable: true,
            }],
        )?;

        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

        queue_computation(ctx.accounts, computation_offset, args, vec![callback_ix], 1, 0)
    }

    #[arcium_callback(encrypted_ix = "submit_bid", auto_serialize = false)]
    pub fn submit_bid_callback(
        ctx: Context<SubmitBidCallback>,
        output: SignedComputationOutputs<BidBookEncProxy>,
    ) -> Result<()> {
        // Use verify_output_raw so the 464-byte SharedEncryptedStruct<13> stays on
        // the heap (inside Vec<u8>) instead of being materialized on the BPF stack.
        // Layout: [0..32] enc_key  [32..48] nonce (u128 LE)  [48..464] ciphertexts
        let raw = output
            .verify_output_raw(
                &ctx.accounts.cluster_account,
                &ctx.accounts.computation_account,
            )
            .map_err(|e| {
                msg!("Error: {}", e);
                error!(ErrorCode::AbortedComputation)
            })?;

        require!(raw.len() == 464, ErrorCode::AbortedComputation);

        // Validate PDA using stored creator
        let creator = ctx.accounts.auction_state.load()?.creator;
        let (expected_pda, _) =
            Pubkey::find_program_address(&[b"auction", &creator], &crate::ID);
        require!(
            expected_pda == ctx.accounts.auction_state.key(),
            ErrorCode::InvalidAuctionState
        );

        let mut state = ctx.accounts.auction_state.load_mut()?;
        state.book_pub_key.copy_from_slice(&raw[0..32]);
        state.book_nonce.copy_from_slice(&raw[32..48]);
        state.book_ciphertexts.copy_from_slice(&raw[48..464]);
        state.bid_count += 1;
        drop(state);

        emit!(BidSubmittedEvent {
            auction: ctx.accounts.auction_state.key(),
        });
        Ok(())
    }

    // ─── Find Winner — Sealed Bid ─────────────────────────────────────────────

    pub fn find_winner_sealed(
        ctx: Context<FindWinnerSealed>,
        computation_offset: u64,
    ) -> Result<()> {
        let state = ctx.accounts.auction_state.load()?;
        let book_pub_key = state.book_pub_key;
        let book_nonce = u128::from_le_bytes(state.book_nonce);

        let mut args = ArgBuilder::new()
            .x25519_pubkey(book_pub_key)
            .plaintext_u128(book_nonce);

        for i in 0..4usize {
            let base = i * 3;
            let mut amount_ct = [0u8; 32];
            let mut lo_ct = [0u8; 32];
            let mut hi_ct = [0u8; 32];
            amount_ct.copy_from_slice(&state.book_ciphertexts[base * 32..(base + 1) * 32]);
            lo_ct.copy_from_slice(&state.book_ciphertexts[(base + 1) * 32..(base + 2) * 32]);
            hi_ct.copy_from_slice(&state.book_ciphertexts[(base + 2) * 32..(base + 3) * 32]);
            args = args
                .encrypted_u64(amount_ct)
                .encrypted_u128(lo_ct)
                .encrypted_u128(hi_ct);
        }
        let mut count_ct = [0u8; 32];
        count_ct.copy_from_slice(&state.book_ciphertexts[12 * 32..]);
        let args = args.encrypted_u64(count_ct).build();
        drop(state);

        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![FindWinnerSealedCallback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[],
            )?],
            1,
            0,
        )
    }

    #[arcium_callback(encrypted_ix = "find_winner_sealed")]
    pub fn find_winner_sealed_callback(
        ctx: Context<FindWinnerSealedCallback>,
        output: SignedComputationOutputs<FindWinnerSealedOutput>,
    ) -> Result<()> {
        match output.verify_output(
            &ctx.accounts.cluster_account,
            &ctx.accounts.computation_account,
        ) {
            Ok(FindWinnerSealedOutput { field_0 }) => {
                emit!(AuctionWinnerEvent {
                    auction_type: 0,
                    clearing_price: field_0.field_0,
                    winner_lo: field_0.field_1,
                    winner_hi: field_0.field_2,
                });
                Ok(())
            }
            Err(e) => {
                msg!("Error: {}", e);
                Err(ErrorCode::AbortedComputation.into())
            }
        }
    }

    // ─── Find Winner — Vickrey ────────────────────────────────────────────────

    pub fn find_winner_vickrey(
        ctx: Context<FindWinnerVickrey>,
        computation_offset: u64,
    ) -> Result<()> {
        let state = ctx.accounts.auction_state.load()?;
        let book_pub_key = state.book_pub_key;
        let book_nonce = u128::from_le_bytes(state.book_nonce);

        let mut args = ArgBuilder::new()
            .x25519_pubkey(book_pub_key)
            .plaintext_u128(book_nonce);

        for i in 0..4usize {
            let base = i * 3;
            let mut amount_ct = [0u8; 32];
            let mut lo_ct = [0u8; 32];
            let mut hi_ct = [0u8; 32];
            amount_ct.copy_from_slice(&state.book_ciphertexts[base * 32..(base + 1) * 32]);
            lo_ct.copy_from_slice(&state.book_ciphertexts[(base + 1) * 32..(base + 2) * 32]);
            hi_ct.copy_from_slice(&state.book_ciphertexts[(base + 2) * 32..(base + 3) * 32]);
            args = args
                .encrypted_u64(amount_ct)
                .encrypted_u128(lo_ct)
                .encrypted_u128(hi_ct);
        }
        let mut count_ct = [0u8; 32];
        count_ct.copy_from_slice(&state.book_ciphertexts[12 * 32..]);
        let args = args.encrypted_u64(count_ct).build();
        drop(state);

        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![FindWinnerVickreyCallback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[],
            )?],
            1,
            0,
        )
    }

    #[arcium_callback(encrypted_ix = "find_winner_vickrey")]
    pub fn find_winner_vickrey_callback(
        ctx: Context<FindWinnerVickreyCallback>,
        output: SignedComputationOutputs<FindWinnerVickreyOutput>,
    ) -> Result<()> {
        match output.verify_output(
            &ctx.accounts.cluster_account,
            &ctx.accounts.computation_account,
        ) {
            Ok(FindWinnerVickreyOutput { field_0 }) => {
                emit!(AuctionWinnerEvent {
                    auction_type: 1,
                    clearing_price: field_0.field_0,
                    winner_lo: field_0.field_1,
                    winner_hi: field_0.field_2,
                });
                Ok(())
            }
            Err(e) => {
                msg!("Error: {}", e);
                Err(ErrorCode::AbortedComputation.into())
            }
        }
    }

    // ─── Find Clearing Price ──────────────────────────────────────────────────

    pub fn find_clearing_price(
        ctx: Context<FindClearingPrice>,
        computation_offset: u64,
    ) -> Result<()> {
        let state = ctx.accounts.auction_state.load()?;
        let book_pub_key = state.book_pub_key;
        let book_nonce = u128::from_le_bytes(state.book_nonce);
        let slots = state.slots;

        let mut args = ArgBuilder::new()
            .x25519_pubkey(book_pub_key)
            .plaintext_u128(book_nonce);

        for i in 0..4usize {
            let base = i * 3;
            let mut amount_ct = [0u8; 32];
            let mut lo_ct = [0u8; 32];
            let mut hi_ct = [0u8; 32];
            amount_ct.copy_from_slice(&state.book_ciphertexts[base * 32..(base + 1) * 32]);
            lo_ct.copy_from_slice(&state.book_ciphertexts[(base + 1) * 32..(base + 2) * 32]);
            hi_ct.copy_from_slice(&state.book_ciphertexts[(base + 2) * 32..(base + 3) * 32]);
            args = args
                .encrypted_u64(amount_ct)
                .encrypted_u128(lo_ct)
                .encrypted_u128(hi_ct);
        }
        let mut count_ct = [0u8; 32];
        count_ct.copy_from_slice(&state.book_ciphertexts[12 * 32..]);
        let args = args.encrypted_u64(count_ct).plaintext_u64(slots).build();
        drop(state);

        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![FindClearingPriceCallback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[],
            )?],
            1,
            0,
        )
    }

    #[arcium_callback(encrypted_ix = "find_clearing_price")]
    pub fn find_clearing_price_callback(
        ctx: Context<FindClearingPriceCallback>,
        output: SignedComputationOutputs<FindClearingPriceOutput>,
    ) -> Result<()> {
        match output.verify_output(
            &ctx.accounts.cluster_account,
            &ctx.accounts.computation_account,
        ) {
            Ok(FindClearingPriceOutput { field_0 }) => {
                emit!(ClearingPriceEvent {
                    clearing_price: field_0,
                });
                Ok(())
            }
            Err(e) => {
                msg!("Error: {}", e);
                Err(ErrorCode::AbortedComputation.into())
            }
        }
    }
}

// ─── Account Structs ──────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct CreateAuction<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(
        init,
        payer = creator,
        space = AUCTION_STATE_SPACE,
        seeds = [b"auction", creator.key().as_ref()],
        bump,
    )]
    pub auction_state: AccountLoader<'info, AuctionState>,
    pub system_program: Program<'info, System>,
}

#[queue_computation_accounts("submit_bid", payer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct SubmitBid<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init_if_needed,
        space = 9,
        payer = payer,
        seeds = [&SIGN_PDA_SEED],
        bump,
        address = derive_sign_pda!(),
    )]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    #[account(mut, address = derive_mempool_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: checked by arcium program.
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: checked by arcium program.
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: checked by arcium program.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_SUBMIT_BID))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(mut, address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Account<'info, FeePool>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Account<'info, ClockAccount>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
    pub auction_state: AccountLoader<'info, AuctionState>,
}

#[callback_accounts("submit_bid")]
#[derive(Accounts)]
pub struct SubmitBidCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_SUBMIT_BID))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    /// CHECK: checked by arcium program.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(address = ::anchor_lang::solana_program::sysvar::instructions::ID)]
    /// CHECK: instructions sysvar.
    pub instructions_sysvar: AccountInfo<'info>,
    #[account(mut)]
    pub auction_state: AccountLoader<'info, AuctionState>,
}

#[init_computation_definition_accounts("submit_bid", payer)]
#[derive(Accounts)]
pub struct InitSubmitBidCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: checked by arcium program.
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_mxe_lut_pda!(mxe_account.lut_offset_slot))]
    /// CHECK: address lookup table.
    pub address_lookup_table: UncheckedAccount<'info>,
    #[account(address = LUT_PROGRAM_ID)]
    /// CHECK: lut program.
    pub lut_program: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

#[queue_computation_accounts("find_winner_sealed", payer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct FindWinnerSealed<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init_if_needed,
        space = 9,
        payer = payer,
        seeds = [&SIGN_PDA_SEED],
        bump,
        address = derive_sign_pda!(),
    )]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    #[account(mut, address = derive_mempool_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: checked by arcium program.
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: checked by arcium program.
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: checked by arcium program.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_FIND_WINNER_SEALED))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(mut, address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Account<'info, FeePool>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Account<'info, ClockAccount>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
    pub auction_state: AccountLoader<'info, AuctionState>,
}

#[callback_accounts("find_winner_sealed")]
#[derive(Accounts)]
pub struct FindWinnerSealedCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_FIND_WINNER_SEALED))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    /// CHECK: checked by arcium program.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(address = ::anchor_lang::solana_program::sysvar::instructions::ID)]
    /// CHECK: instructions sysvar.
    pub instructions_sysvar: AccountInfo<'info>,
}

#[init_computation_definition_accounts("find_winner_sealed", payer)]
#[derive(Accounts)]
pub struct InitFindWinnerSealedCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: checked by arcium program.
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_mxe_lut_pda!(mxe_account.lut_offset_slot))]
    /// CHECK: address lookup table.
    pub address_lookup_table: UncheckedAccount<'info>,
    #[account(address = LUT_PROGRAM_ID)]
    /// CHECK: lut program.
    pub lut_program: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

#[queue_computation_accounts("find_winner_vickrey", payer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct FindWinnerVickrey<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init_if_needed,
        space = 9,
        payer = payer,
        seeds = [&SIGN_PDA_SEED],
        bump,
        address = derive_sign_pda!(),
    )]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    #[account(mut, address = derive_mempool_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: checked by arcium program.
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: checked by arcium program.
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: checked by arcium program.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_FIND_WINNER_VICKREY))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(mut, address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Account<'info, FeePool>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Account<'info, ClockAccount>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
    pub auction_state: AccountLoader<'info, AuctionState>,
}

#[callback_accounts("find_winner_vickrey")]
#[derive(Accounts)]
pub struct FindWinnerVickreyCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_FIND_WINNER_VICKREY))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    /// CHECK: checked by arcium program.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(address = ::anchor_lang::solana_program::sysvar::instructions::ID)]
    /// CHECK: instructions sysvar.
    pub instructions_sysvar: AccountInfo<'info>,
}

#[init_computation_definition_accounts("find_winner_vickrey", payer)]
#[derive(Accounts)]
pub struct InitFindWinnerVickreyCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: checked by arcium program.
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_mxe_lut_pda!(mxe_account.lut_offset_slot))]
    /// CHECK: address lookup table.
    pub address_lookup_table: UncheckedAccount<'info>,
    #[account(address = LUT_PROGRAM_ID)]
    /// CHECK: lut program.
    pub lut_program: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

#[queue_computation_accounts("find_clearing_price", payer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct FindClearingPrice<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init_if_needed,
        space = 9,
        payer = payer,
        seeds = [&SIGN_PDA_SEED],
        bump,
        address = derive_sign_pda!(),
    )]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    #[account(mut, address = derive_mempool_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: checked by arcium program.
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: checked by arcium program.
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: checked by arcium program.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_FIND_CLEARING_PRICE))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(mut, address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Account<'info, FeePool>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Account<'info, ClockAccount>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
    pub auction_state: AccountLoader<'info, AuctionState>,
}

#[callback_accounts("find_clearing_price")]
#[derive(Accounts)]
pub struct FindClearingPriceCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_FIND_CLEARING_PRICE))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    /// CHECK: checked by arcium program.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(address = ::anchor_lang::solana_program::sysvar::instructions::ID)]
    /// CHECK: instructions sysvar.
    pub instructions_sysvar: AccountInfo<'info>,
}

#[init_computation_definition_accounts("find_clearing_price", payer)]
#[derive(Accounts)]
pub struct InitFindClearingPriceCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: checked by arcium program.
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_mxe_lut_pda!(mxe_account.lut_offset_slot))]
    /// CHECK: address lookup table.
    pub address_lookup_table: UncheckedAccount<'info>,
    #[account(address = LUT_PROGRAM_ID)]
    /// CHECK: lut program.
    pub lut_program: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

// ─── Events ────────────────────────────────────────────────────────────────────

#[event]
pub struct BidSubmittedEvent {
    pub auction: Pubkey,
}

#[event]
pub struct AuctionWinnerEvent {
    pub auction_type: u8,
    pub clearing_price: u64,
    pub winner_lo: u128,
    pub winner_hi: u128,
}

#[event]
pub struct ClearingPriceEvent {
    pub clearing_price: u64,
}

// ─── Errors ────────────────────────────────────────────────────────────────────

#[error_code]
pub enum ErrorCode {
    #[msg("Computation was aborted")]
    AbortedComputation,
    #[msg("Cluster not set")]
    ClusterNotSet,
    #[msg("Invalid auction state account")]
    InvalidAuctionState,
}
