import { TitleBar } from "@/components/title-bar";
import { useEffect, useState } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { FirstTimeSetup } from "@/components/setup/first-time-setup";
import { PasswordPrompter } from "@/components/password-prompter";

export function App() {
  const [isFirstTime, setIsFirstTime] = useState<boolean | null>(null);
  const [isPasswordPromptOpen, setIsPasswordPromptOpen] = useState(true);

  useEffect(() => {
    window.vault.isFirstTimeSetup().then((result: boolean) => {
      setIsFirstTime(result);
    });
  }, []);

  if (isFirstTime === null) {
    return null;
  }

  if (isFirstTime) {
    return <FirstTimeSetup onComplete={() => setIsFirstTime(false)} />;
  }

  if (isPasswordPromptOpen) {
    return (
      <PasswordPrompter onUnlocked={() => setIsPasswordPromptOpen(false)} />
    );
  }

  return (
    <div className="flex h-svh flex-col bg-background rounded-md overflow-hidden border border-neutral-600 dark:border-neutral-800">
      <TitleBar
        serverAddress="zuna.example.com:8080"
        ping={42}
        onSettings={() => console.log("settings")}
      />
      <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
        You're all set up. Main app content goes here.
      </div>
    </div>
  );
}

export default App;
