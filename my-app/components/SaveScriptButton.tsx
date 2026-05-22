"use client";

import { useRouter } from "next/navigation";

export type ChangeKind = "breaking" | "additive" | "patch";

type Props = {
  sqlContent: string;
  suggestedName: string;
  suggestedDescription: string;
  sourceLabel: string;
  changeKind: ChangeKind;
};

export type PendingScript = {
  sql_content: string;
  script_name: string;
  description: string;
  sourceLabel: string;
  changeKind: ChangeKind;
};

export const PENDING_SCRIPT_KEY = "pendingScript";

export default function SaveScriptButton({
  sqlContent,
  suggestedName,
  suggestedDescription,
  sourceLabel,
  changeKind,
}: Props) {
  const router = useRouter();

  const handleSave = () => {
    const payload: PendingScript = {
      sql_content: sqlContent,
      script_name: suggestedName,
      description: suggestedDescription,
      sourceLabel,
      changeKind,
    };
    sessionStorage.setItem(PENDING_SCRIPT_KEY, JSON.stringify(payload));
    router.push("/scripts");
  };

  return (
    <button
      className="compare-btn compare-btn--save"
      type="button"
      onClick={handleSave}
    >
      Save to Registry
    </button>
  );
}
