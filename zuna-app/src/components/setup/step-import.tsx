import * as React from "react";
import { UploadCloudIcon, FileIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

interface StepImportProps {
  onImported: () => void;
  onBack: () => void;
}

export function StepImport({ onImported, onBack }: StepImportProps) {
  const [dragging, setDragging] = React.useState(false);
  const [file, setFile] = React.useState<File | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const accept = (picked: File) => {
    setError(null);
    setFile(picked);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(true);
  };

  const handleDragLeave = () => setDragging(false);

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const dropped = e.dataTransfer.files[0];
    if (dropped) accept(dropped);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = e.target.files?.[0];
    if (picked) accept(picked);
    e.target.value = "";
  };

  const handleImport = async () => {
    if (!file) return;
    setLoading(true);
    setError(null);
    try {
      const buffer = await file.arrayBuffer();
      const base64 = btoa(String.fromCharCode(...new Uint8Array(buffer)));
      await window.vault.import(base64);
      onImported();
    } catch (e: any) {
      setError(
        "Failed to import vault. Make sure the file is a valid vault.bin.",
      );
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h2 className="text-lg font-semibold">Import Your Data</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Select your existing{" "}
          <code className="text-xs font-mono bg-muted px-1 py-0.5 rounded">
            vault.bin
          </code>{" "}
          file to restore your keys and settings. You'll be asked for your PIN
          afterwards.
        </p>
      </div>

      <div
        role="button"
        tabIndex={0}
        aria-label="Select vault.bin file"
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => e.key === "Enter" && inputRef.current?.click()}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={cn(
          "flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed px-6 py-10 cursor-pointer transition-colors select-none",
          dragging
            ? "border-primary bg-primary/5"
            : "border-border bg-muted/30 hover:border-primary/50 hover:bg-muted/60",
        )}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".bin"
          className="hidden"
          onChange={handleFileChange}
        />
        {file ? (
          <>
            <div className="flex size-12 items-center justify-center rounded-full bg-primary/10">
              <FileIcon className="size-5 text-primary" />
            </div>
            <div className="flex flex-col items-center gap-0.5 text-center">
              <span className="text-sm font-medium">{file.name}</span>
              <span className="text-xs text-muted-foreground">
                {(file.size / 1024).toFixed(1)} KB · Click to change
              </span>
            </div>
          </>
        ) : (
          <>
            <div className="flex size-12 items-center justify-center rounded-full bg-muted">
              <UploadCloudIcon className="size-5 text-muted-foreground" />
            </div>
            <div className="flex flex-col items-center gap-0.5 text-center">
              <span className="text-sm font-medium">Drop vault.bin here</span>
              <span className="text-xs text-muted-foreground">
                or click to browse
              </span>
            </div>
          </>
        )}
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-xs text-destructive">
          <XIcon className="size-3.5 mt-0.5 shrink-0" />
          {error}
        </div>
      )}

      <div className="flex items-center justify-between">
        <Button variant="outline" onClick={onBack} disabled={loading}>
          Back
        </Button>
        <Button onClick={handleImport} disabled={!file || loading}>
          {loading ? (
            <>
              <Spinner className="size-3.5 mr-1.5" />
              Importing…
            </>
          ) : (
            "Import Vault"
          )}
        </Button>
      </div>
    </div>
  );
}
