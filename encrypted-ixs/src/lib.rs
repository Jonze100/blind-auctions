use arcis::*;

#[encrypted]
mod circuits {
    use arcis::*;

    const MAX_BIDS: usize = 4;

    #[derive(Copy, Clone)]
    pub struct Bid {
        amount: u64,
        bidder_lo: u128,  // lower 16 bytes of Solana pubkey
        bidder_hi: u128,  // upper 16 bytes of Solana pubkey
    }

    #[derive(Copy, Clone)]
    pub struct BidBook {
        bids: [Bid; MAX_BIDS],
        count: u64,
    }

    // Circuit 1: Submit a bid — stored encrypted, only MXE can read
    // bid_count is the public on-chain count (0 on first bid). Using it as the
    // insertion index avoids relying on book.count, which is garbage when the
    // AuctionState book_ciphertexts are zero-initialized.
    #[instruction]
    pub fn submit_bid(
        bid_ctxt: Enc<Shared, Bid>,
        book_ctxt: Enc<Shared, BidBook>,
        bid_count: u64,
    ) -> Enc<Shared, BidBook> {
        let bid = bid_ctxt.to_arcis();
        let mut book = book_ctxt.to_arcis();
        let idx = bid_count as usize;
        for i in 0..MAX_BIDS {
            if i == idx {
                book.bids[i] = bid;
            }
        }
        book.count = bid_count + 1;
        book_ctxt.owner.from_arcis(book)
    }

    // Circuit 2: Find winner — Sealed-Bid (highest bid wins, pays their bid)
    #[instruction]
    pub fn find_winner_sealed(
        book_ctxt: Enc<Shared, BidBook>,
    ) -> (u64, u128, u128) {
        let book = book_ctxt.to_arcis();
        let mut winning_amount: u64 = 0;
        let mut winning_lo: u128 = 0;
        let mut winning_hi: u128 = 0;

        for i in 0..MAX_BIDS {
            let active = i < book.count as usize;
            let bid = book.bids[i];
            let is_higher = bid.amount > winning_amount;
            let is_tie = bid.amount == winning_amount;
            // Use RNG as tiebreaker
            let tiebreak = ArcisRNG::bool();
            let take = active && (is_higher || (is_tie && tiebreak));
            if take {
                winning_amount = bid.amount;
                winning_lo = bid.bidder_lo;
                winning_hi = bid.bidder_hi;
            }
        }
        (winning_amount.reveal(), winning_lo.reveal(), winning_hi.reveal())
    }

    // Circuit 3: Find winner — Vickrey (highest bid wins, pays second-highest price)
    #[instruction]
    pub fn find_winner_vickrey(
        book_ctxt: Enc<Shared, BidBook>,
    ) -> (u64, u128, u128) {
        let book = book_ctxt.to_arcis();
        let mut first_amount: u64 = 0;
        let mut second_amount: u64 = 0;
        let mut winning_lo: u128 = 0;
        let mut winning_hi: u128 = 0;

        for i in 0..MAX_BIDS {
            let active = i < book.count as usize;
            let bid = book.bids[i];
            let beats_first = bid.amount > first_amount;
            if active && beats_first {
                second_amount = first_amount;
                first_amount = bid.amount;
                winning_lo = bid.bidder_lo;
                winning_hi = bid.bidder_hi;
            } else {
                let beats_second = active && bid.amount > second_amount && bid.amount <= first_amount;
                if beats_second {
                    second_amount = bid.amount;
                }
            }
        }
        // Winner pays second-highest price
        (second_amount.reveal(), winning_lo.reveal(), winning_hi.reveal())
    }

    // Circuit 4: Find clearing price — Uniform (top N winners pay same price)
    #[instruction]
    pub fn find_clearing_price(
        book_ctxt: Enc<Shared, BidBook>,
        slots: u64,
    ) -> u64 {
        let book = book_ctxt.to_arcis();
        // Find the Nth highest bid = clearing price
        // Simple approach: find the minimum of the top-N bids
        let mut top: [u64; MAX_BIDS] = [0u64; MAX_BIDS];
        for i in 0..MAX_BIDS {
            let active = i < book.count as usize;
            if active {
                top[i] = book.bids[i].amount;
            }
        }
        // Sort descending to find Nth price
        // Bubble sort (works in MPC with fixed iterations)
        for i in 0..MAX_BIDS {
            for j in 0..(MAX_BIDS - 1) {
                if top[j] < top[j + 1] {
                    let tmp = top[j];
                    top[j] = top[j + 1];
                    top[j + 1] = tmp;
                }
            }
        }
        let n = (slots as usize).min(MAX_BIDS) - 1;
        top[n].reveal()
    }
}
