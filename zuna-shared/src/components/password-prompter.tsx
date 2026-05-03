import * as React from "react";
import { REGEXP_ONLY_DIGITS } from "input-otp";
import { LockIcon } from "lucide-react";
import { TitleBar } from "@/components/title-bar";
import { usePlatform } from "../platform";
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSlot,
} from "@/components/ui/input-otp";

interface PasswordPrompterProps {
  onUnlocked: () => void;
  title?: string;
  description?: string;
}

export function PasswordPrompter({
  onUnlocked,
  title = "Welcome back",
  description = "Enter your 4-digit PIN to unlock Zuna.",
}: PasswordPrompterProps) {
  const [pin, setPin] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const otpContainerRef = React.useRef<HTMLDivElement>(null);
  const { vault } = usePlatform();

  const focusOtpInput = React.useCallback(() => {
    const input = otpContainerRef.current?.querySelector("input");
    if (input instanceof HTMLInputElement) {
      input.focus();
    }
  }, []);

  async function attempt(value: string) {
    if (value.length < 4) return;
    setLoading(true);
    setError(null);
    try {
      await vault.unlock(value);
      onUnlocked();
    } catch {
      setError("Incorrect PIN. Please try again.");
      setPin("");
      requestAnimationFrame(focusOtpInput);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex h-svh flex-col bg-background rounded-md overflow-hidden border border-neutral-600 dark:border-neutral-800">
      <TitleBar />

      <div className="flex flex-1 flex-col items-center justify-center px-6 py-10">
        <div className="flex w-full max-w-xs flex-col items-center gap-6">
          <div className="flex size-14 items-center justify-center rounded-full bg-primary/10">
            <LockIcon className="size-6 text-primary" />
          </div>

          <div className="text-center">
            <h1 className="text-xl font-semibold">{title}</h1>
            <p className="mt-1 text-sm text-muted-foreground">{description}</p>
          </div>

          <div ref={otpContainerRef}>
            <InputOTP
              maxLength={4}
              pattern={REGEXP_ONLY_DIGITS}
              value={pin}
              onChange={(v) => {
                setError(null);
                setPin(v);
              }}
              onComplete={(v) => attempt(v)}
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
            {error && <p className="text-xs text-destructive">{error}</p>}
            {loading && (
              <p className="text-xs text-muted-foreground">Unlocking…</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
