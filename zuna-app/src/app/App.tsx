import { Button } from "@/components/ui/button";
import { useEffect, useMemo, useState } from "react";

export function App() {
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [privateKey, setPrivateKey] = useState<string | null>(null);

  useEffect(() => {
    const generateKeys = async () => {
      await window.security.generateEncryptionKeyPair().then((keyPair) => {
        setPublicKey(keyPair.publicKey);
        setPrivateKey(keyPair.privateKey);
      });
    };
    generateKeys();
  }, []);

  return (
    <div className="flex min-h-svh p-6">
      <div className="flex max-w-md min-w-0 flex-col gap-4 text-sm leading-loose">
        <div>
          <h1 className="font-medium">Project ready!</h1>
          <p>You may now add components and start building.</p>
          <p>We&apos;ve already added the button component for you.</p>
          <Button className="mt-2">Button</Button>
        </div>

        <p>
          {publicKey ? `Public Key: ${publicKey}` : "Generating key pair..."}
        </p>
        <p>
          {privateKey ? `Private Key: ${privateKey}` : "Generating key pair..."}
        </p>
        <div className="font-mono text-xs text-muted-foreground">
          (Press <kbd>d</kbd> to toggle dark mode)
        </div>
      </div>
    </div>
  );
}

export default App;
