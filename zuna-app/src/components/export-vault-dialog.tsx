import * as React from "react";
import { REGEXP_ONLY_DIGITS } from "input-otp";
import { AlertTriangleIcon, DownloadIcon, LockIcon, ServerIcon } from "lucide-react";
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
import { Button } from "@/components/ui/button";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";

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
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [saveStatus, setSaveStatus] = React.useState<string | null>(null);
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
      setSaveStatus(null);
      setExportUrl(null);
      setQrDataUrl(null);
      window.vault.stopExportServer();
    }
  }, [open]);

  async function handleSaveToDisk() {
    if (pin.length < 4) {
      setSaveStatus("Enter your PIN first.");
      return;
    }

    setSaving(true);
    setSaveStatus(null);
    setError(null);

    try {
      const result = await window.vault.saveExportFile(pin);
      if (!result.ok) {
        if (result.reason === "invalid_pin") {
          setError("Incorrect PIN. Please try again.");
          setPin("");
          requestAnimationFrame(focusOtp);
          return;
        }

        if (result.reason === "no_vault") {
          setSaveStatus("No vault data is available to export.");
          return;
        }

        setSaveStatus("Save cancelled.");
        return;
      }

      setSaveStatus("Vault file saved successfully.");
    } catch {
      setSaveStatus("Failed to save vault file.");
    } finally {
      setSaving(false);
    }
  }

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

  const securityWarning = (
    <Alert variant="destructive" className="w-full">
      <AlertTriangleIcon aria-hidden="true" />
      <AlertTitle>Security Warning</AlertTitle>
      <AlertDescription>
        Keep your vault private and never share it with anyone. It is your
        identity on connected servers.
      </AlertDescription>
    </Alert>
  );

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

              <div className="-mt-8 w-full">{securityWarning}</div>
            </div>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <ServerIcon className="size-4" />
                Export Vault
              </DialogTitle>
              <DialogDescription>
                Scan the QR code with your phone or open the URL on another
                device. Do not close this window until export is complete.
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

              <Button
                type="button"
                variant="outline"
                className="w-full"
                onClick={handleSaveToDisk}
                disabled={saving || loading}
              >
                {saving ? "Saving..." : "Save Vault File to Disk"}
              </Button>

              <div className="h-4 w-full text-center">
                {saveStatus && (
                  <p className="text-xs text-muted-foreground">{saveStatus}</p>
                )}
              </div>

              <div className="-mt-8 w-full">{securityWarning}</div>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
