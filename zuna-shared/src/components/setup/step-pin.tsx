import * as React from "react";
import { REGEXP_ONLY_DIGITS } from "input-otp";
import { LockIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSeparator,
  InputOTPSlot,
} from "@/components/ui/input-otp";

interface StepPinProps {
  onNext: (pin: string) => Promise<void>;
  onBack: () => void;
}

export function StepPin({ onNext, onBack }: StepPinProps) {
  const [pin, setPin] = React.useState("");
  const [confirm, setConfirm] = React.useState("");
  const [loading, setLoading] = React.useState(false);

  const mismatch = confirm.length === 4 && pin !== confirm;
  const ready = pin.length === 4 && confirm.length === 4 && !mismatch;

  const handleSubmit = async () => {
    if (!ready) return;
    setLoading(true);
    await onNext(pin);
    setLoading(false);
  };

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-lg font-semibold">Set Your App PIN</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Your 4-digit PIN encrypts the vault that stores your keys on this
          device. You'll use it every time you open Zuna.
        </p>
      </div>

      <div className="flex flex-col items-center gap-2 py-2 rounded-xl bg-muted/40 border border-border/50">
        <div className="flex size-10 items-center justify-center rounded-full bg-primary/10 mt-4">
          <LockIcon className="size-4 text-primary" />
        </div>

        <div className="flex flex-col items-center gap-1.5 mt-2">
          <span className="text-sm font-medium">Enter PIN</span>
          <InputOTP
            maxLength={4}
            pattern={REGEXP_ONLY_DIGITS}
            value={pin}
            onChange={setPin}
            autoFocus
          >
            <InputOTPGroup>
              <InputOTPSlot index={0} />
              <InputOTPSlot index={1} />
              <InputOTPSlot index={2} />
              <InputOTPSlot index={3} />
            </InputOTPGroup>
          </InputOTP>
        </div>

        <div className="flex flex-col items-center gap-1.5 mt-4 mb-5">
          <span className="text-sm font-medium text-muted-foreground">
            Confirm PIN
          </span>
          <InputOTP
            maxLength={4}
            pattern={REGEXP_ONLY_DIGITS}
            value={confirm}
            onChange={setConfirm}
            disabled={pin.length < 4}
          >
            <InputOTPGroup>
              <InputOTPSlot index={0} aria-invalid={mismatch || undefined} />
              <InputOTPSlot index={1} aria-invalid={mismatch || undefined} />
              <InputOTPSlot index={2} aria-invalid={mismatch || undefined} />
              <InputOTPSlot index={3} aria-invalid={mismatch || undefined} />
            </InputOTPGroup>
          </InputOTP>
          <div className="h-4 mt-0.5">
            {mismatch && (
              <p className="text-xs text-destructive">PINs do not match</p>
            )}
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between">
        <Button variant="outline" onClick={onBack} disabled={loading}>
          Back
        </Button>
        <Button onClick={handleSubmit} disabled={!ready || loading}>
          {loading ? "Securing keys…" : "Set PIN & Continue"}
        </Button>
      </div>
    </div>
  );
}
