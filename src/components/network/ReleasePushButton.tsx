"use client";

// "Send anyway (N changes)": releases a held first push (guardrail 2) from
// Build → Network. One click instead of a config edit and a restart; the
// stored flag is one-shot (the loop clears it once the push goes through).
import { useState } from "react";
import { useRouter } from "next/navigation";
import ConfirmButton from "@/components/ui/ConfirmButton";

export default function ReleasePushButton({ heldOpsCount }: { heldOpsCount: number }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  async function release() {
    setError(null);
    const res = await fetch("/api/sync/release-push", { method: "POST" });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      setError(data.error ?? "The push could not be released.");
      return;
    }
    router.refresh();
  }

  return (
    <span className="mt-1.5 inline-flex flex-wrap items-center gap-2">
      <ConfirmButton
        title={`Send these ${heldOpsCount} changes to the other copy?`}
        description="This guard exists because a bad restore can look like thousands of edits. Only release it if you know what these pending changes are — a real import, a bulk edit you made on purpose."
        confirmLabel={`Send anyway (${heldOpsCount})`}
        panelClassName="w-80"
        trigger={<span>Send anyway ({heldOpsCount} changes)</span>}
        triggerClassName="rounded-card border border-line-strong bg-surface-2 px-2.5 py-1 text-xs text-ink hover:bg-surface-3"
        onConfirm={() => void release()}
      />
      {error && <span className="ui-meta text-rose-400">{error}</span>}
    </span>
  );
}
