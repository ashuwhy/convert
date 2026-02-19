import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface LayoutProps {
    children: ReactNode;
    className?: string;
}

export function Layout({ children, className }: LayoutProps) {
    return (
        <div className={cn("min-h-screen bg-background font-sans antialiased", className)}>
            <div className="container mx-auto px-4 py-8">
                {children}
            </div>
        </div>
    );
}
