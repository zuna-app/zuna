import * as React from "react";
import { CopyIcon, RefreshCwIcon, ShieldIcon, PenLineIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export interface KeyPairs {
  encryption: { publicKey: string; privateKey: string };
  signing: { publicKey: string; privateKey: string };
}

interface StepKeysProps {
  keys: KeyPairs | null;
  onRegenerate: () => Promise<void>;
  onNext: (keys: KeyPairs) => void;
}

function truncateKey(key: string): string {
  if (key.length <= 24) return key;
  return key.slice(0, 12) + "…" + key.slice(-8);
}

function KeyRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = React.useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="flex items-center gap-2 py-1.5">
      <span className="text-xs text-muted-foreground w-20 shrink-0">
        {label}
      </span>
      <Tooltip>
        <TooltipTrigger asChild>
          <code className="flex-1 min-w-0 text-xs font-mono bg-muted/50 px-2 py-1 rounded-md truncate cursor-default select-none border border-border/50">
            {truncateKey(value)}
          </code>
        </TooltipTrigger>
        <TooltipContent>
          <code className="font-mono text-[10px] break-all">{value}</code>
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            size="icon"
            variant="ghost"
            className="size-6 shrink-0"
            onClick={handleCopy}
          >
            {copied ? (
              <span className="text-[10px] text-green-500 font-medium">✓</span>
            ) : (
              <CopyIcon className="size-3" />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          {copied ? "Copied!" : "Copy to clipboard"}
        </TooltipContent>
      </Tooltip>
    </div>
  );
}

export function StepKeys({ keys, onRegenerate, onNext }: StepKeysProps) {
  const [regenerating, setRegenerating] = React.useState(false);

  const handleRegenerate = async () => {
    setRegenerating(true);
    await onRegenerate();
    setRegenerating(false);
  };

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h2 className="text-lg font-semibold">Create Your Keys</h2>
        <p className="text-sm text-muted-foreground mt-1">
          These keys are used to encrypt messages and confirm your identity.
        </p>
      </div>

      <div className="grid gap-3">
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2.5">
              <div className="flex size-7 shrink-0 items-center justify-center rounded-md bg-blue-500/10">
                <ShieldIcon className="size-3.5 text-blue-500" />
              </div>
              <div className="min-w-0 flex-1">
                <CardTitle>Encryption Keys</CardTitle>
                <CardDescription>End-to-end encrypted messages</CardDescription>
              </div>
              <Badge variant="secondary" className="shrink-0">
                X25519
              </Badge>
            </div>
          </CardHeader>
          <CardContent>
            {keys ? (
              <>
                <KeyRow label="Public Key" value={keys.encryption.publicKey} />
                <Separator />
                <KeyRow
                  label="Private Key"
                  value={keys.encryption.privateKey}
                />
              </>
            ) : (
              <div className="flex items-center justify-center py-4">
                <Spinner className="size-4" />
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center gap-2.5">
              <div className="flex size-7 shrink-0 items-center justify-center rounded-md bg-purple-500/10">
                <PenLineIcon className="size-3.5 text-purple-500" />
              </div>
              <div className="min-w-0 flex-1">
                <CardTitle>Signing Keys</CardTitle>
                <CardDescription>
                  Verify your device authenticity
                </CardDescription>
              </div>
              <Badge variant="secondary" className="shrink-0">
                Ed25519
              </Badge>
            </div>
          </CardHeader>
          <CardContent>
            {keys ? (
              <>
                <KeyRow label="Public Key" value={keys.signing.publicKey} />
                <Separator />
                <KeyRow label="Private Key" value={keys.signing.privateKey} />
              </>
            ) : (
              <div className="flex items-center justify-center py-4">
                <Spinner className="size-4" />
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <p className="text-xs text-muted-foreground">
        Your private keys will be stored securely on this device. They will
        never be uploaded to any server or shared with anyone. Make sure to keep
        them safe, as they are required to access your messages and identity.
      </p>

      <div className="flex items-center justify-between">
        <Button
          variant="outline"
          size="sm"
          onClick={handleRegenerate}
          disabled={regenerating || !keys}
        >
          <RefreshCwIcon
            className={cn("size-3.5 mr-1.5", regenerating && "animate-spin")}
          />
          Regenerate Keys
        </Button>
        <Button onClick={() => keys && onNext(keys)} disabled={!keys}>
          Continue
        </Button>
      </div>
    </div>
  );
}
