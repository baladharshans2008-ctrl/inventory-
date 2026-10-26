import { Link } from "react-router-dom";
import { Compass } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/States";

export default function NotFound() {
  return (
    <div className="container py-20">
      <EmptyState
        icon={Compass}
        title="This route does not exist"
        description="The page you were looking for is not part of the RailFlow AI prototype. Head back to the booking search to continue."
        action={
          <Button asChild className="mt-2">
            <Link to="/search">Search trains</Link>
          </Button>
        }
      />
    </div>
  );
}
