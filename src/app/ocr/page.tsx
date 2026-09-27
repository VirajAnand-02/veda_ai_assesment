import type { Metadata } from "next";
import { OcrPlayground } from "@/components/ocr/ocr-playground";

export const metadata: Metadata = {
  title: "OCR comparison · VedaAI",
};

export default function OcrPage() {
  return <OcrPlayground />;
}
