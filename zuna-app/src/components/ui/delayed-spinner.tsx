import { Loader, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";

export const DelayedSpinner = ({ delay = 500 }: { delay?: number }) => {
  const [showSpinner, setShowSpinner] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      setShowSpinner(true);
    }, delay);

    return () => clearTimeout(timer);
  }, [delay]);

  if (!showSpinner) return null;

  return <Loader2 className="size-4 animate-spin text-muted-foreground" />;
};
