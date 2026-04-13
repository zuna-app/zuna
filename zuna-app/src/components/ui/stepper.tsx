import * as React from "react";
import { CheckIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export interface Step {
  label: string;
  description?: string;
}

interface StepperProps {
  steps: Step[];
  currentStep: number;
  className?: string;
}

export function Stepper({ steps, currentStep, className }: StepperProps) {
  return (
    <div className={cn("flex items-start w-full", className)}>
      {steps.map((step, i) => {
        const isCompleted = i < currentStep;
        const isCurrent = i === currentStep;
        const isLast = i === steps.length - 1;

        return (
          <React.Fragment key={i}>
            <div className="flex flex-col items-center gap-2 min-w-0">
              <div
                className={cn(
                  "flex size-8 shrink-0 items-center justify-center rounded-full border-2 text-xs font-semibold transition-all duration-300",
                  isCompleted &&
                    "border-primary bg-primary text-primary-foreground",
                  isCurrent &&
                    "border-primary bg-background text-primary shadow-[0_0_0_4px_hsl(var(--primary)/0.12)]",
                  !isCompleted &&
                    !isCurrent &&
                    "border-muted-foreground/25 bg-background text-muted-foreground/40",
                )}
              >
                {isCompleted ? (
                  <CheckIcon className="size-4" />
                ) : (
                  <span>{i + 1}</span>
                )}
              </div>
              <div className="flex flex-col items-center text-center px-1 max-w-24">
                <span
                  className={cn(
                    "text-xs font-medium leading-tight transition-colors",
                    isCurrent && "text-foreground",
                    isCompleted && "text-muted-foreground",
                    !isCompleted && !isCurrent && "text-muted-foreground/40",
                  )}
                >
                  {step.label}
                </span>
                {step.description && (
                  <span
                    className={cn(
                      "text-xs leading-tight mt-0.5 transition-colors",
                      isCurrent && "text-muted-foreground",
                      !isCurrent && "text-muted-foreground/35",
                    )}
                  >
                    {step.description}
                  </span>
                )}
              </div>
            </div>
            {!isLast && (
              <div
                className={cn(
                  "mt-4 flex-1 h-px mx-3 shrink rounded-full transition-all duration-500",
                  isCompleted ? "bg-primary" : "bg-border",
                )}
              />
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}
