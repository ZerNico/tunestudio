import { createSignal } from "solid-js";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { checkForUpdates } from "~/lib/updates";

import appLicense from "../../../../../LICENSE?raw";
import { LicensesDialog } from "./licenses-dialog";
import { Row, Section } from "./section";

/** The app's name and version, its own license, and the licenses of what it is built on. */
export function AboutSection(props: { version: string | null; onShowModels: () => void }) {
  const [licenseOpen, setLicenseOpen] = createSignal(false);
  const [noticesOpen, setNoticesOpen] = createSignal(false);
  const [checking, setChecking] = createSignal(false);
  const check = async () => {
    setChecking(true);
    await checkForUpdates();
    setChecking(false);
  };

  return (
    <Section id="about" title="About" description="Tune Studio is free and open source.">
      <div class="flex flex-col divide-y divide-border rounded-[10px] border border-border bg-card">
        <Row id="about-app" label="Tune Studio" description="An editor for UltraStar charts.">
          <span class="font-mono text-[11px] text-foreground" data-testid="about-version">
            {props.version ? `Version ${props.version}` : "Version unknown"}
          </span>
        </Row>
        <Row id="about-updates" label="Updates" description="New versions come from Tune Studio's releases on GitHub.">
          <Button
            variant="outline"
            size="sm"
            disabled={checking()}
            onClick={() => void check()}
            data-testid="about-updates"
          >
            {checking() ? "Checking…" : "Check for updates"}
          </Button>
        </Row>
        <Row id="about-license" label="License" description="Free and open source under the MIT license.">
          <Button variant="outline" size="sm" onClick={() => setLicenseOpen(true)} data-testid="about-license">
            Read the license
          </Button>
        </Row>
        <Row
          id="about-notices"
          label="Open source licenses"
          description="The libraries and tools Tune Studio is built with, and their licenses."
        >
          <Button variant="outline" size="sm" onClick={() => setNoticesOpen(true)} data-testid="about-notices">
            Show licenses
          </Button>
        </Row>
      </div>

      <Dialog open={licenseOpen()} onOpenChange={(open: boolean) => setLicenseOpen(open)}>
        <DialogContent class="w-[min(640px,calc(100vw-32px))]" data-testid="app-license">
          <DialogHeader>
            <DialogTitle>MIT license</DialogTitle>
            <DialogDescription>Tune Studio may be used, changed and shared freely under these terms.</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <pre class="m-0 font-mono text-[11px] leading-[1.6] whitespace-pre-wrap text-muted-foreground">
              {appLicense.trim()}
            </pre>
          </DialogBody>
        </DialogContent>
      </Dialog>

      <LicensesDialog
        open={noticesOpen()}
        onOpenChange={setNoticesOpen}
        onShowModels={() => {
          setNoticesOpen(false);
          props.onShowModels();
        }}
      />
    </Section>
  );
}
