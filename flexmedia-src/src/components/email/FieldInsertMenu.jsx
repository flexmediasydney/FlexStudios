import React from "react";
import { usePriceGate } from "@/components/auth/RoleGate";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { ChevronDown, User, Building2, Users, FileText, Calendar } from "lucide-react";

export default function FieldInsertMenu({ onInsert }) {
  const { showPricing } = usePriceGate();
  const fields = {
    "Client (Agent)": [
      { label: "First Name", value: "{{agent_first_name}}", icon: User },
      { label: "Last Name", value: "{{agent_last_name}}", icon: User },
      { label: "Email", value: "{{agent_email}}", icon: User },
      { label: "Phone", value: "{{agent_phone}}", icon: User },
      { label: "Company", value: "{{agent_company}}", icon: Building2 },
    ],
    Agency: [
      { label: "Agency Name", value: "{{agency_name}}", icon: Building2 },
      { label: "Agency Email", value: "{{agency_email}}", icon: Building2 },
      { label: "Agency Phone", value: "{{agency_phone}}", icon: Building2 },
    ],
    Project: [
      { label: "Project Title", value: "{{project_title}}", icon: FileText },
      { label: "Property Address", value: "{{project_address}}", icon: FileText },
      { label: "Shoot Date", value: "{{project_shoot_date}}", icon: Calendar },
      { label: "Delivery Date", value: "{{project_delivery_date}}", icon: Calendar },
      ...(showPricing ? [{ label: "Price", value: "{{project_price}}", icon: FileText }] : []),
    ],
    General: [
      { label: "Current Date", value: "{{current_date}}", icon: Calendar },
      { label: "User Name", value: "{{user_name}}", icon: User },
      { label: "User Email", value: "{{user_email}}", icon: User },
    ],
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="text-xs">
          Insert field
          <ChevronDown className="h-3 w-3 ml-1" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        {Object.entries(fields).map(([category, categoryFields], idx) => (
          <div key={category}>
            {idx > 0 && <DropdownMenuSeparator />}
            <DropdownMenuSub>
              <DropdownMenuSubTrigger className="text-xs">
                {category}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                {categoryFields.map((field) => {
                  const Icon = field.icon;
                  return (
                    <DropdownMenuItem
                      key={field.value}
                      onClick={() => onInsert(field.value)}
                      className="text-xs cursor-pointer flex items-center gap-2"
                    >
                      {Icon && <Icon className="h-3.5 w-3.5 text-gray-500" />}
                      {field.label}
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}