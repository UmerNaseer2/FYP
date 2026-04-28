"use client";

import { useState } from "react";

export default function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <button className="compare-btn compare-btn--secondary" onClick={handleCopy}>
      {copied ? "Copied!" : "Copy SQL"}
    </button>
  );
}
