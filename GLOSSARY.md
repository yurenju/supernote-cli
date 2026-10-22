# Supernote Cloud client

A command-line way to browse, download, upload and organise the notebooks and files a Supernote device syncs through Supernote Cloud.

## Language

**Supernote Cloud**:
The hosted file service at `cloud.supernote.com` that a Supernote device syncs to, reached here through an unofficial API.
_Avoid_: Private Cloud (Ratta's self-hosted server is a different product)

**Access token**:
The credential that proves who you are to Supernote Cloud. It comes from logging in, expires after a while, and is the only secret this tool reads.
_Avoid_: key, session, password

**Identity verification**:
The extra login step Supernote Cloud may demand for a device it has not seen before: a one-time code emailed to the account owner, valid for about two minutes. It always needs a human.
_Avoid_: 2FA, OTP

**Mark**:
The handwriting a device adds on top of a PDF, kept as a separate `<name>.pdf.mark` file beside the PDF it annotates, which stays unchanged. Supernote Cloud can render the two together as one PDF.
_Avoid_: annotation file, overlay
