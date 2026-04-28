import * as React from "react";
import { REGEXP_ONLY_DIGITS } from "input-otp";
import { DownloadIcon, LockIcon, ServerIcon } from "lucide-react";
import QRCode from "qrcode";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSlot,
} from "@/components/ui/input-otp";

type Step = "pin" | "qr";

interface ExportVaultDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ExportVaultDialog({
  open,
  onOpenChange,
}: ExportVaultDialogProps) {
  const [step, setStep] = React.useState<Step>("pin");
  const [pin, setPin] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [exportUrl, setExportUrl] = React.useState<string | null>(null);
  const [qrDataUrl, setQrDataUrl] = React.useState<string | null>(null);
  const otpRef = React.useRef<HTMLDivElement>(null);

  const focusOtp = React.useCallback(() => {
    const input = otpRef.current?.querySelector("input");
    if (input instanceof HTMLInputElement) input.focus();
  }, []);

  React.useEffect(() => {
    if (!open) {
      setStep("pin");
      setPin("");
      setError(null);
      setExportUrl(null);
      setQrDataUrl(null);
      window.vault.stopExportServer();
    }
  }, [open]);

  async function handlePinComplete(value: string) {
    if (value.length < 4) return;
    setLoading(true);
    setError(null);
    try {
      const result = await window.vault.startExportServer(value);
      if (!result) {
        setError("Incorrect PIN. Please try again.");
        setPin("");
        requestAnimationFrame(focusOtp);
        return;
      }
      const dataUrl = await QRCode.toDataURL(result.url, {
        margin: 1,
        width: 220,
        color: { dark: "#000000", light: "#ffffff" },
      });
      setExportUrl(result.url);
      setQrDataUrl(dataUrl);
      setStep("qr");
    } catch {
      setError("Incorrect PIN. Please try again.");
      setPin("");
      requestAnimationFrame(focusOtp);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        {step === "pin" ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <DownloadIcon className="size-4" />
                Export Vault
              </DialogTitle>
              <DialogDescription>
                Enter your PIN to authorize the vault export.
              </DialogDescription>
            </DialogHeader>

            <div className="flex flex-col items-center gap-4 py-3">
              <div className="flex size-12 items-center justify-center rounded-full bg-primary/10">
                <LockIcon className="size-5 text-primary" />
              </div>

              <div ref={otpRef}>
                <InputOTP
                  maxLength={4}
                  pattern={REGEXP_ONLY_DIGITS}
                  value={pin}
                  onChange={(v) => {
                    setError(null);
                    setPin(v);
                  }}
                  onComplete={handlePinComplete}
                  autoFocus
                  disabled={loading}
                >
                  <InputOTPGroup>
                    <InputOTPSlot index={0} aria-invalid={!!error || undefined} />
                    <InputOTPSlot index={1} aria-invalid={!!error || undefined} />
                    <InputOTPSlot index={2} aria-invalid={!!error || undefined} />
                    <InputOTPSlot index={3} aria-invalid={!!error || undefined} />
                  </InputOTPGroup>
                </InputOTP>
              </div>

              <div className="h-4">
                {error && (
                  <p className="text-xs text-destructive">{error}</p>
                )}
                {loading && (
                  <p className="text-xs text-muted-foreground">Verifying…</p>
                )}
              </div>
            </div>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <ServerIcon className="size-4" />
                Download Vault
              </DialogTitle>
              <DialogDescription>
                Scan the QR code with your phone or open the URL on another
                device. Do not close this until export is complete.
              </DialogDescription>
            </DialogHeader>

            <div className="flex flex-col items-center gap-4 py-2">
              {qrDataUrl && (
                <div className="rounded-xl border border-border/60 p-2 bg-white">
                  <img
                    src={qrDataUrl}
                    alt="QR code for vault download"
                    className="size-52 block"
                  />
                </div>
              )}

              {exportUrl && (
                <div className="w-full rounded-lg border border-border/50 bg-muted/50 px-3 py-2">
                  <p className="break-all font-mono text-[11px] text-muted-foreground leading-relaxed">
                    {exportUrl}
                  </p>
                </div>
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
