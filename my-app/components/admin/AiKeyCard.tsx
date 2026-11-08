"use client";

import { useId, useState, type FormEvent } from "react";
import { Button, Card, ConfirmDialog, Input, Label } from "@/components/ui";
import { AlertCircleIcon } from "@/components/ui/icons";
import { Select } from "@/components/ui/Select";
import { apiFetch } from "@/lib/api-fetch";
import { errorFrom, jsonOf } from "@/lib/api-answer";
import {
  AI_KEY_PROVIDERS,
  AI_KEY_PROVIDER_LIST,
  MAX_KEY_LENGTH,
  isAiKeyProvider,
  type AiKeyProvider,
} from "@/lib/ai/key-providers";
import { isAiAdminView, type AiAdminView } from "@/lib/ai/views";

/**
 * The "Organization AI key" card on the Admin screen's AI tab
 * (app/api/admin/ai/key/route.ts).
 *
 * An Admin can save one key for the whole organization, for one of the
 * services in lib/ai/key-providers.ts. Every AI call for the organization then
 * uses that key instead of the server's AI settings. The key is write-only:
 * after saving, the screen only shows which service it is for and its last
 * four characters. Removing it puts the organization back on the server's
 * settings.
 */

const SERVICE_OPTIONS = AI_KEY_PROVIDER_LIST.map((p) => ({ value: p.key, label: p.label }));

/** The Admin's own model name, or "" when the key uses the service's usual one. */
function ownModel(view: AiAdminView, tier: "fast" | "smart"): string {
  const key = view.orgKey;
  if (!key) return "";
  const name = key.models[tier];
  return name === AI_KEY_PROVIDERS[key.provider].models[tier] ? "" : name;
}

export function AiKeyCard({ view, onChange }: { view: AiAdminView; onChange: (view: AiAdminView) => void }) {
  const saved = view.orgKey;
  const [provider, setProvider] = useState<AiKeyProvider>(saved?.provider ?? AI_KEY_PROVIDER_LIST[0].key);
  const [apiKey, setApiKey] = useState("");
  const [modelSmart, setModelSmart] = useState(() => ownModel(view, "smart"));
  const [modelFast, setModelFast] = useState(() => ownModel(view, "fast"));
  const [busy, setBusy] = useState<"save" | "remove" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const keyId = useId();
  const serviceId = useId();
  const smartId = useId();
  const fastId = useId();

  const info = AI_KEY_PROVIDERS[provider];
  const editable = view.canUpdate && view.canStoreKeys;
  const locked = !editable || busy !== null;

  async function send(method: "PUT" | "DELETE") {
    setBusy(method === "PUT" ? "save" : "remove");
    setProblem(null);
    try {
      const response = await apiFetch("/api/admin/ai/key", {
        method,
        headers: method === "PUT" ? { "Content-Type": "application/json" } : undefined,
        body: method === "PUT" ? JSON.stringify({ provider, apiKey, modelFast, modelSmart }) : undefined,
      });
      const body = await jsonOf(response);
      if (!response.ok || !isAiAdminView(body)) {
        setProblem(errorFrom(body) ?? (method === "PUT" ? "Could not save the key." : "Could not remove the key."));
        return;
      }
      // The key leaves the page as soon as it is saved.
      setApiKey("");
      if (method === "DELETE") {
        setModelFast("");
        setModelSmart("");
      }
      onChange(body);
    } catch {
      setProblem("Network error. Nothing was changed.");
    } finally {
      setBusy(null);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (apiKey.trim() === "") {
      setProblem("Paste the API key first.");
      return;
    }
    void send("PUT");
  }

  return (
    <Card className="p-4 sm:p-5">
      <h3 className="section-title">Organization AI key</h3>
      <p className="text-[13px] mt-2 max-w-[68ch]" style={{ color: "var(--text-2)" }}>
        {"AI uses the service set up on this server unless an Admin saves this organization's own key here. " +
          "Every AI call for this organization then goes to that service with that key, and is billed to that account."}
      </p>

      <p className="text-[13px] mt-3" role="status">
        {saved
          ? `A key for ${saved.service} is saved, ending in ${saved.hint}. Models: ${saved.models.smart} for reviews and explanations, ${saved.models.fast} for short summaries.`
          : "No key saved. AI uses the server's settings."}
      </p>
      {saved && saved.setBy && saved.setAt && (
        <p className="text-[12px] mt-1" style={{ color: "var(--text-3)" }}>
          {`Saved by ${saved.setBy}, ${new Date(saved.setAt).toLocaleString()}.`}
        </p>
      )}

      {saved && !saved.readable && (
        <div className="role-note mt-3" role="alert">
          <AlertCircleIcon size={15} className="ico" />
          <div>
            <div className="title">{"The saved key can't be read on this server"}</div>
            <div className="body">
              {"It was locked with an encryption key this server no longer has, for example after APP_ENCRYPTION_KEY changed or the data came from another server. " +
                "AI is off for this organization until an Admin saves the key again or removes it."}
            </div>
          </div>
        </div>
      )}

      {!view.canUpdate ? (
        <p className="text-[12.5px] mt-3" style={{ color: "var(--text-3)" }}>
          Only an Admin can save or remove the key.
        </p>
      ) : !view.canStoreKeys ? (
        <p className="text-[12.5px] mt-3 max-w-[68ch]" style={{ color: "var(--text-3)" }}>
          {"This server has no encryption key, so it can't keep an AI key safe and won't save one. " +
            "Whoever runs the server can set APP_ENCRYPTION_KEY and restart it."}
        </p>
      ) : null}

      {view.canUpdate && (
        <form className="mt-4" onSubmit={submit} noValidate>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor={serviceId} className="mb-1 block">
                Service
              </Label>
              <Select
                id={serviceId}
                variant="input"
                value={provider}
                options={SERVICE_OPTIONS}
                disabled={locked}
                onChange={(value) => {
                  if (!isAiKeyProvider(value)) return;
                  setProvider(value);
                  // Model names belong to one service.
                  setModelFast("");
                  setModelSmart("");
                  setProblem(null);
                }}
              />
            </div>
            <div>
              <Label htmlFor={keyId} className="mb-1 block">
                API key
              </Label>
              <Input
                id={keyId}
                type="password"
                mono
                value={apiKey}
                maxLength={MAX_KEY_LENGTH}
                placeholder={saved ? "Paste a new key to replace the saved one" : "Paste the key"}
                autoComplete="off"
                spellCheck={false}
                readOnly={locked}
                onChange={(event) => {
                  setApiKey(event.target.value);
                  setProblem(null);
                }}
                aria-describedby={`${keyId}-help`}
              />
              <p id={`${keyId}-help`} className="text-[12.5px] mt-1.5" style={{ color: "var(--text-3)" }}>
                {`Make one at ${info.keyPage}. It is stored encrypted and never shown again, only its last four characters.`}
              </p>
            </div>
            <div>
              <Label htmlFor={smartId} className="mb-1 block">
                Model for reviews and explanations
              </Label>
              <Input
                id={smartId}
                mono
                value={modelSmart}
                placeholder={info.models.smart}
                autoComplete="off"
                spellCheck={false}
                readOnly={locked}
                onChange={(event) => setModelSmart(event.target.value)}
              />
            </div>
            <div>
              <Label htmlFor={fastId} className="mb-1 block">
                Model for short summaries
              </Label>
              <Input
                id={fastId}
                mono
                value={modelFast}
                placeholder={info.models.fast}
                autoComplete="off"
                spellCheck={false}
                readOnly={locked}
                onChange={(event) => setModelFast(event.target.value)}
              />
            </div>
          </div>
          <p className="text-[12.5px] mt-2 max-w-[68ch]" style={{ color: "var(--text-3)" }}>
            {"Leave the model names empty to use the ones shown. The key is not tried when you save it: " +
              "if the service turns it down, the AI buttons say so the first time someone uses them."}
          </p>

          {problem && (
            <p className="field-problem mt-3" role="alert">
              {problem}
            </p>
          )}

          <div className="mt-4 flex flex-wrap gap-2">
            <Button type="submit" size="sm" disabled={locked}>
              {busy === "save" ? "Saving..." : saved ? "Replace key" : "Save key"}
            </Button>
            {saved && (
              <Button type="button" variant="ghost" size="sm" disabled={locked} onClick={() => setConfirmRemove(true)}>
                {busy === "remove" ? "Removing..." : "Remove key"}
              </Button>
            )}
          </div>
        </form>
      )}

      <ConfirmDialog
        open={confirmRemove}
        onClose={() => setConfirmRemove(false)}
        onConfirm={() => void send("DELETE")}
        title="Remove the organization's AI key?"
        description="The app forgets the key, and this organization's AI calls go back to the service set up on this server. If the server has none, AI stops working here until a key is saved again. The removal goes in the change log."
        confirmLabel="Remove"
        destructive
      />
    </Card>
  );
}
