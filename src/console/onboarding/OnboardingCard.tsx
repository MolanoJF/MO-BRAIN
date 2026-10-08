import type { ReactNode } from 'react';
import { ArrowLeft } from 'lucide-react';
import { PRODUCT_NAME } from '../../control/lifecycle.ts';
import { Card, IconButton, Icon, PageTitle } from '../ui/index.tsx';

const STEPS = ['Sign in', 'API key', 'Ready'] as const;

/**
 * The one frame for the three first-run screens: a centred card with a step
 * indicator and an optional Back button. Only tokens: done and current
 * segments are `bg-accent`, upcoming ones `bg-border`.
 */
export function OnboardingCard({
  step, onBack, title, subtitle, children, foot,
}: {
  /** Omit for a plain returning sign-in, which has no stepper. */
  step?: 1 | 2 | 3;
  onBack?: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  children?: ReactNode;
  foot?: ReactNode;
}) {
  return (
    <div className="min-h-screen bg-bg flex flex-col items-center justify-center gap-4 px-4 py-8">
      <div className="text-sm font-medium text-muted">{PRODUCT_NAME}</div>
      <Card className="w-full max-w-md space-y-4" foot={foot}>
        {(onBack || step) && (
          <div className="flex items-center gap-3">
            {onBack && (
              <IconButton label="Back" onClick={onBack}>
                <Icon glyph={ArrowLeft} size={16} />
              </IconButton>
            )}
            {step && (
              <ol className="flex flex-1 gap-2" aria-label={`Step ${step} of 3`}>
                {STEPS.map((name, i) => {
                  const n = i + 1;
                  return (
                    <li key={name} className="flex-1 space-y-1"
                        aria-current={n === step ? 'step' : undefined}>
                      <div className={n <= step ? 'h-1 rounded-[var(--radius-pill)] bg-accent' : 'h-1 rounded-[var(--radius-pill)] bg-border'} />
                      <div className={n === step ? 'text-xs font-medium text-text' : 'text-xs text-muted'}>{name}</div>
                    </li>
                  );
                })}
              </ol>
            )}
          </div>
        )}
        <div className="space-y-1">
          <PageTitle>{title}</PageTitle>
          {subtitle && <p className="text-sm text-muted">{subtitle}</p>}
        </div>
        {children}
      </Card>
    </div>
  );
}
