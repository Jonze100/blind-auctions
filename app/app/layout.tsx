import type { Metadata } from "next";
import "./globals.css";
import { AppWalletProvider } from "@/components/WalletProvider";
import { Header } from "@/components/Header";

export const metadata: Metadata = {
  title: "BlindAuctions — Arcium MPC on Solana",
  description: "Sealed-bid, Vickrey, and uniform-price auctions with fully encrypted bids",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <AppWalletProvider>
          <Header />
          {children}
        </AppWalletProvider>
      </body>
    </html>
  );
}
