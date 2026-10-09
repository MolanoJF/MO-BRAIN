import type { ReactNode } from 'react';
import { ArrowLeft } from 'lucide-react';
import { PRODUCT_NAME } from '../../control/lifecycle.ts';
import { Card, Icon, PageTitle } from '../ui/index.tsx';

/**
 * The one frame for the three first-run screens: a centred card with an
 * optional small Back button.
 */
export function OnboardingCard({
  onBack, title, subtitle, children, foot,
}: {
  onBack?: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  children?: ReactNode;
  foot?: ReactNode;
}) {
  return (
    <div className="min-h-screen bg-bg flex flex-col items-center justify-center gap-4 px-4 py-8">
      <div className="text-sm font-medium text-muted">{PRODUCT_NAME}</div>
      <Card className="w-full max-w-lg p-10 space-y-6" foot={foot}>
        {onBack && (
          <button type="button" onClick={onBack}
                  className="-mt-2 inline-flex w-fit items-center gap-1 text-xs text-muted hover:text-text">
            <Icon glyph={ArrowLeft} size={12} />
            Back
          </button>
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
