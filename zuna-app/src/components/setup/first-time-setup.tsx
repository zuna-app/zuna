import * as React from "react";
import { TitleBar } from "@/components/title-bar";
import { Stepper, type Step } from "@/components/ui/stepper";
import { StepKeys, type KeyPairs } from "./step-keys";
import { StepPin } from "./step-pin";
import { StepJoinServer, type ServerJoinData } from "./step-join-server";
import { StepImport } from "./step-import";

const STEPS: Step[] = [
  { label: "Create Keys", description: "Encryption & signing" },
  { label: "Set PIN", description: "Secure your vault" },
  { label: "Join Server", description: "Connect & start" },
];

interface FirstTimeSetupProps {
  onComplete: () => void;
}

export function FirstTimeSetup({ onComplete }: FirstTimeSetupProps) {
  const [importing, setImporting] = React.useState(false);
  const [step, setStep] = React.useState(0);
  const [keys, setKeys] = React.useState<KeyPairs | null>(null);
  const [pendingKeys, setPendingKeys] = React.useState<KeyPairs | null>(null);

  const generateKeys = React.useCallback(async () => {
    setKeys(null);
    const [encryption, signing] = await Promise.all([
      window.security.generateEncryptionKeyPair(),
      window.security.generateSigningKeyPair(),
    ]);
    setKeys({ encryption, signing });
  }, []);

  React.useEffect(() => {
    generateKeys();
  }, [generateKeys]);

  const handleKeysNext = (confirmed: KeyPairs) => {
    setPendingKeys(confirmed);
    setStep(1);
  };

  const handlePinNext = async (pin: string) => {
    if (!pendingKeys) return;
    await window.vault.unlock(pin);
    await Promise.all([
      window.vault.set("encPublicKey", pendingKeys.encryption.publicKey),
      window.vault.set("encPrivateKey", pendingKeys.encryption.privateKey),
      window.vault.set("sigPublicKey", pendingKeys.signing.publicKey),
      window.vault.set("sigPrivateKey", pendingKeys.signing.privateKey),
    ]);
    setStep(2);
  };

  const handleServerJoin = (_data: ServerJoinData) => {
    onComplete();
  };

  return (
    <div className="flex h-svh flex-col bg-background rounded-md overflow-hidden border border-neutral-600 dark:border-neutral-800">
      <TitleBar />

      <div className="flex flex-1 flex-col items-center justify-center px-6 py-10 overflow-y-auto">
        <div className="w-full max-w-lg flex flex-col gap-8">
          <div className="text-center">
            <h1 className="text-2xl font-bold tracking-tight">
              Welcome to Zuna
            </h1>
            <p className="text-sm text-muted-foreground mt-1.5">
              {importing
                ? "Restore your existing vault to pick up where you left off."
                : "Let's get you set up in just a few steps."}
            </p>
          </div>

          {!importing && <Stepper steps={STEPS} currentStep={step} />}

          <div className="rounded-xl ring-1 ring-foreground/10 bg-card shadow-sm p-6 transition-all">
            {importing ? (
              <StepImport
                onImported={onComplete}
                onBack={() => setImporting(false)}
              />
            ) : (
              <>
                {step === 0 && (
                  <StepKeys
                    keys={keys}
                    onRegenerate={generateKeys}
                    onNext={handleKeysNext}
                  />
                )}
                {step === 1 && (
                  <StepPin onNext={handlePinNext} onBack={() => setStep(0)} />
                )}
                {step === 2 && (
                  <StepJoinServer
                    onNext={handleServerJoin}
                    onBack={() => setStep(1)}
                    nextLabel="Finish Setup"
                  />
                )}
              </>
            )}
          </div>

          {importing ? null : (
            <div className="flex items-center justify-center gap-1.5">
              <p className="text-center text-xs text-muted-foreground/60">
                Step {step + 1} of {STEPS.length}
              </p>
              <span className="text-xs text-muted-foreground/40">·</span>
              <button
                onClick={() => setImporting(true)}
                className="text-xs text-muted-foreground/60 underline-offset-2 hover:text-foreground hover:underline transition-colors"
              >
                Import existing vault
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
