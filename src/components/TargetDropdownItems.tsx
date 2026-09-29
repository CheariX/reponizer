import { Form, Icon, Image } from "@raycast/api";
import type { TargetOption } from "../lib/targets";

/**
 * Items for a host or namespace dropdown fed by `useRepoTarget`. A plain function rather than a
 * component: Raycast only accepts `Form.Dropdown.Item`s as direct children of a dropdown.
 */
export function targetDropdownItems(options: TargetOption[], icon: Image.ImageLike, emptyTitle: string) {
  return options.map((option) => (
    <Form.Dropdown.Item
      key={option.value}
      value={option.value}
      title={option.value || emptyTitle}
      icon={option.isNew ? Icon.PlusCircle : icon}
    />
  ));
}
