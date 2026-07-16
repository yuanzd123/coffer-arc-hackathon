import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Coffer × Arc | Programmable Agent Spend",
  description: "Verified Arc Testnet evidence and a safe fixed-scenario walkthrough of policy-first agent USDC settlement."
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
