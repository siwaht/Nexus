import { LucideIcon } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

interface ComingSoonTabProps {
  title: string;
  description: string;
  icon: LucideIcon;
}

export function ComingSoonTab({ title, description, icon: Icon }: ComingSoonTabProps) {
  return (
    <Card className="border-card-border">
      <CardHeader className="text-center space-y-4 py-12">
        <div className="mx-auto w-16 h-16 rounded-xl bg-muted flex items-center justify-center">
          <Icon className="w-8 h-8 text-muted-foreground" />
        </div>
        <div>
          <CardTitle className="text-xl">{title}</CardTitle>
          <CardDescription className="text-base mt-2 max-w-md mx-auto">
            {description}
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="text-center pb-12">
        <p className="text-sm text-muted-foreground">Coming in a future milestone</p>
      </CardContent>
    </Card>
  );
}
