import * as React from "react";
import AvatarEditor, { type AvatarEditorRef } from "react-avatar-editor";
import {
  ServerIcon,
  Upload,
  X,
  RotateCcw,
  RotateCw,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { ZunaAvatar } from "../avatar";

export interface ServerJoinData {
  serverAddress: string;
  serverPassword: string;
  username: string;
  avatar: string | null;
}

interface StepJoinServerProps {
  onNext: (data: ServerJoinData) => void;
  onBack?: () => void;
  showBack?: boolean;
  nextLabel?: string;
  loading?: boolean;
  error?: string | null;
}

function AvatarEditorDialog({
  open,
  image,
  onApply,
  onCancel,
}: {
  open: boolean;
  image: string;
  onApply: (dataUrl: string) => void;
  onCancel: () => void;
}) {
  const editorRef = React.useRef<AvatarEditorRef>(null);
  const [zoom, setZoom] = React.useState(1);
  const [rotate, setRotate] = React.useState(0);

  React.useEffect(() => {
    if (open) {
      setZoom(1);
      setRotate(0);
    }
  }, [open, image]);

  const handleApply = () => {
    if (!editorRef.current) return;
    const canvas = editorRef.current.getImageScaledToCanvas();
    onApply(canvas.toDataURL("image/png"));
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onCancel()}>
      <DialogContent showCloseButton={false} className="sm:max-w-xs">
        <DialogHeader>
          <DialogTitle>Adjust Avatar</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col items-center gap-4">
          <div className="rounded-xl overflow-hidden ring-1 ring-border/60">
            <AvatarEditor
              ref={editorRef}
              image={image}
              width={220}
              height={220}
              border={16}
              borderRadius={9999}
              scale={zoom}
              rotate={rotate}
              color={[0, 0, 0, 0.45]}
            />
          </div>

          {/* Zoom */}
          <div className="w-full grid gap-1.5">
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">Zoom</span>
              <span className="text-xs tabular-nums text-muted-foreground">
                {zoom.toFixed(2)}×
              </span>
            </div>
            <div className="flex items-center gap-2">
              <ZoomOut className="size-3.5 shrink-0 text-muted-foreground" />
              <input
                type="range"
                min={1}
                max={3}
                step={0.01}
                value={zoom}
                onChange={(e) => setZoom(Number(e.target.value))}
                className="w-full accent-primary h-1.5 cursor-pointer rounded-full"
              />
              <ZoomIn className="size-3.5 shrink-0 text-muted-foreground" />
            </div>
          </div>

          {/* Rotation */}
          <div className="w-full grid gap-1.5">
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">Rotation</span>
              <span className="text-xs tabular-nums text-muted-foreground">
                {rotate}°
              </span>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setRotate((r) => (r - 90 + 360) % 360)}
                className="p-1 rounded hover:bg-muted transition-colors"
                aria-label="Rotate left 90°"
              >
                <RotateCcw className="size-3.5 text-muted-foreground" />
              </button>
              <input
                type="range"
                min={0}
                max={359}
                step={1}
                value={rotate}
                onChange={(e) => setRotate(Number(e.target.value))}
                className="w-full accent-primary h-1.5 cursor-pointer rounded-full"
              />
              <button
                type="button"
                onClick={() => setRotate((r) => (r + 90) % 360)}
                className="p-1 rounded hover:bg-muted transition-colors"
                aria-label="Rotate right 90°"
              >
                <RotateCw className="size-3.5 text-muted-foreground" />
              </button>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button size="sm" onClick={handleApply}>
            Apply
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function StepJoinServer({
  onNext,
  onBack,
  showBack = true,
  nextLabel = "Join Server",
  loading = false,
  error = null,
}: StepJoinServerProps) {
  const [serverAddress, setServerAddress] = React.useState("");
  const [serverPassword, setServerPassword] = React.useState("");
  const [username, setUsername] = React.useState("");
  const [avatar, setAvatar] = React.useState<string | null>(null);
  const [pendingImage, setPendingImage] = React.useState<string | null>(null);
  const [editorOpen, setEditorOpen] = React.useState(false);
  const avatarInputRef = React.useRef<HTMLInputElement>(null);

  const handleAvatarChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setPendingImage(reader.result as string);
      setEditorOpen(true);
    };
    reader.readAsDataURL(file);
    e.target.value = "";
  };

  const handleEditorApply = (dataUrl: string) => {
    setAvatar(dataUrl);
    setPendingImage(null);
    setEditorOpen(false);
  };

  const handleEditorCancel = () => {
    setPendingImage(null);
    setEditorOpen(false);
  };

  const canContinue =
    serverAddress.trim().length > 0 && username.trim().length > 0;

  const handleNext = () => {
    if (!canContinue) return;
    onNext({
      serverAddress: serverAddress.trim(),
      serverPassword,
      username: username.trim(),
      avatar,
    });
  };

  return (
    <>
      {pendingImage && (
        <AvatarEditorDialog
          open={editorOpen}
          image={pendingImage}
          onApply={handleEditorApply}
          onCancel={handleEditorCancel}
        />
      )}

      <div className="flex flex-col gap-5">
        <div>
          <h2 className="text-lg font-semibold">Join a Server</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Connect to a Zuna server to start communicating securely with
            others.
          </p>
        </div>

        <div className="grid gap-4">
          <div className="rounded-lg border border-border/60 bg-card/50 p-4 grid gap-3">
            <div className="flex items-center gap-2 mb-0.5">
              <ServerIcon className="size-3.5 text-muted-foreground" />
              <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Server
              </span>
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="server-address">
                Address{" "}
                <Badge variant="destructive" className="h-4 text-[10px] ml-1">
                  required
                </Badge>
              </Label>
              <Input
                id="server-address"
                placeholder="zuna.example.com:8080"
                value={serverAddress}
                onChange={(e) => setServerAddress(e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="server-password">
                Password{" "}
                <span className="text-xs font-normal text-muted-foreground">
                  (optional)
                </span>
              </Label>
              <Input
                id="server-password"
                type="password"
                placeholder="Leave empty if the server is open"
                value={serverPassword}
                onChange={(e) => setServerPassword(e.target.value)}
                autoComplete="new-password"
              />
            </div>
          </div>

          <Separator />

          <div className="grid gap-3">
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Your Identity
              </span>
            </div>

            <div className="flex items-center gap-4">
              <div className="grid gap-1.5 flex-1 min-w-0">
                <Label htmlFor="username">
                  Username{" "}
                  <Badge variant="destructive" className="h-4 text-[10px] ml-1">
                    required
                  </Badge>
                </Label>
                <Input
                  id="username"
                  placeholder="your_username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
              <div className="flex flex-col items-center gap-1.5 mt-5 shrink-0">
                <input
                  ref={avatarInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={handleAvatarChange}
                />
                <div
                  className="relative group cursor-pointer"
                  onClick={() => avatarInputRef.current?.click()}
                >
                  <ZunaAvatar
                    username={username}
                    src={avatar || undefined}
                    isOnline={false}
                  />
                  <div className="absolute inset-0 rounded-full bg-black/50 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                    <Upload className="size-4 text-white" />
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <span className="text-[10px] text-muted-foreground">
                    {avatar ? "Change" : "Upload"}
                  </span>
                  {avatar && (
                    <button
                      type="button"
                      onClick={() => setAvatar(null)}
                      className="text-[10px] text-muted-foreground hover:text-destructive transition-colors"
                      aria-label="Remove avatar"
                    >
                      <X className="size-2.5" />
                    </button>
                  )}
                </div>
              </div>
            </div>
            <p className="text-xs text-muted-foreground -mt-1">
              {avatar
                ? "Click the avatar to change it, or remove it to use the generated one."
                : "Click the avatar to upload a custom image, or leave it to use the generated one."}
            </p>
          </div>
        </div>

        <div className="flex items-center justify-between">
          {showBack && onBack ? (
            <Button variant="outline" onClick={onBack} disabled={loading}>
              Back
            </Button>
          ) : (
            <div />
          )}
          <div className="flex flex-col items-end gap-1.5">
            {error && (
              <p className="text-xs text-destructive text-right max-w-56">
                {error}
              </p>
            )}
            <Button onClick={handleNext} disabled={!canContinue || loading}>
              {loading ? "Joining…" : nextLabel}
            </Button>
          </div>
        </div>
      </div>
    </>
  );
}
