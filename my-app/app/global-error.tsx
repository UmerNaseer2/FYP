"use client";

import { useEffect } from "react";

// ---------------------------------------------------------------------------
// The last boundary. This one catches a throw in the ROOT layout itself —
// app/layout.tsx, or the session provider it wraps every page in. When that
// happens there is no layout left to render inside, so this file has to supply
// its own <html> and <body>; Next replaces the whole document with it.
//
// That is also why nothing here is imported. globals.css is loaded by the root
// layout, and the root layout is exactly what has just failed, so the design
// tokens, the fonts and every shared component may be unavailable. The few
// styles below are written out longhand for that reason, and are the only place
// in the app allowed to hard-code a colour.
//
// It should essentially never be seen. It exists so that the one failure that
// takes the whole application down still produces a sentence and a button,
// rather than an unstyled browser error.
// ---------------------------------------------------------------------------

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("The application shell failed to render:", error);
  }, [error]);

  return (
    <html lang="en">
      <body>
        {/* Both themes, because the attribute that normally picks one is set by
            the layout that is not rendering. */}
        <style>{`
          .ge { min-height: 100vh; margin: 0; display: grid; place-items: center;
                background: #f7f7f8; color: #18181b; padding: 24px;
                font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; }
          .ge__box { max-width: 460px; text-align: center; }
          .ge__title { font-size: 18px; font-weight: 600; margin: 0 0 8px; }
          .ge__body { font-size: 13.5px; line-height: 1.55; color: #52525b; margin: 0; }
          .ge__ref { font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
                     font-size: 12px; display: block; margin-top: 8px; }
          .ge__btn { margin-top: 20px; font: inherit; font-size: 13px; font-weight: 500;
                     padding: 8px 16px; border-radius: 8px; cursor: pointer;
                     border: 1px solid #18181b; background: #18181b; color: #fff; }
          @media (prefers-color-scheme: dark) {
            .ge { background: #0a0a0c; color: #f3f3f5; }
            .ge__body { color: #b0b0ba; }
            .ge__btn { border-color: #f3f3f5; background: #f3f3f5; color: #0a0a0c; }
          }
        `}</style>
        <div className="ge">
          <div className="ge__box">
            <h1 className="ge__title">Schema Studio could not start</h1>
            <p className="ge__body">
              The application failed before any screen could be drawn. Reloading
              usually fixes it. If it does not, the server is the place to look
              — no database was touched.
              {error.digest && (
                <span className="ge__ref">Reference: {error.digest}</span>
              )}
            </p>
            <button type="button" className="ge__btn" onClick={reset}>
              Reload
            </button>
          </div>
        </div>
      </body>
    </html>
  );
}
