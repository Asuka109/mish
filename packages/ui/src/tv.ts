import {
  cnMerge,
  createTV,
  cx,
  type CnOptions,
  type CnReturn,
  type TWMergeConfig,
} from "tailwind-variants";

const twMergeConfig = {
  extend: {
    classGroups: {
      "font-size": [
        {
          text: ["title", "body", "metadata", "caption", "label-small", "micro"],
        },
      ],
    },
  },
} satisfies TWMergeConfig;

export const tv = createTV({ twMerge: true, twMergeConfig });

export function cn<T extends CnOptions>(...classes: T): CnReturn {
  return cnMerge(...classes)({ twMerge: true, twMergeConfig });
}

export { cx };
