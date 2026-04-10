// This file is part of React-Invenio-Forms
// Copyright (C) 2022-2026 CERN.
// Copyright (C) 2020 Northwestern University.
// Copyright (C) 2024 KTH Royal Institute of Technology.
//
// React-Invenio-Forms is free software; you can redistribute it and/or modify it
// under the terms of the MIT License; see LICENSE file for more details.
import React, { Component } from "react";
import { Editor } from "@tinymce/tinymce-react";
import "tinymce/tinymce";
import "tinymce/models/dom/model";
import "tinymce/themes/silver";
import "tinymce/icons/default";
import "tinymce/plugins/table";
import "tinymce/plugins/autoresize";
import "tinymce/plugins/code";
import "tinymce/plugins/codesample";
import "tinymce/plugins/image";
import "tinymce/plugins/link";
import "tinymce/plugins/lists";
import "tinymce/plugins/wordcount";
import "tinymce/plugins/preview";
import "tinymce/plugins/advlist";
import "tinymce/plugins/autolink";
import "tinymce/plugins/charmap";
import "tinymce/plugins/searchreplace";
import "tinymce/plugins/visualblocks";
import "tinymce/plugins/fullscreen";
import "tinymce/plugins/insertdatetime";
import "tinymce/plugins/media";
import { marked } from "marked";
import DOMPurify from "dompurify";
import imageCompression from "browser-image-compression";
import PropTypes from "prop-types";
import { Button, Message } from "semantic-ui-react";
import { FilesList } from "./FilesList";

// Make content inside the editor look identical to how we will render it across the site.
// TinyMCE runs within an iframe, so we cannot style it with page-wide CSS styles as normal.
//
// TinyMCE overrides blockquotes with custom styles, so we need to use !important to override
// the overrides in a consistent and reliable way.
// https://github.com/tinymce/tinymce-dist/blob/8d7491f2ee341c201b68cc7c3701d54703edd474/skins/content/tinymce-5/content.css#L61-L70
const editorContentStyle = (disabled) => `
body {
  font-size: 14px;
  ${disabled ? "opacity: 0.5; " : ""}
}

blockquote  {
  margin-left: 0.5rem !important;
  padding-left: 1rem !important;
  color: #757575;
  border-left: 4px solid #C5C5C5 !important;
}

blockquote > blockquote {
  margin-left: 0 !important;
}
`;

/**
 * Component providing rich text editor support and optional files support.
 *
 * @param {object} props
 * @param {array} props.files The list of files, each file is expected to provide the properties `file_id`, `key`, `original_filename`, `size`, `links.download_html`.
 * @param {func} props.onFilesChange The function to call when the list of files changed.
 * @param {func} props.onFileUpload The function to call when uploading a file.
 * @param {func} props.onFileDelete The function to call when deleting a file from the list.
 * @returns {JSX.Element}
 */
export class RichEditor extends Component {
  constructor(props) {
    super(props);

    this.state = {
      fileErrors: [],
    };

    this.editorRef = React.createRef();
    this.editorDialogRef = React.createRef();
  }

  addToFileErrors = (filename, error) => {
    this.setState((prevState) => ({
      fileErrors: [
        ...prevState.fileErrors,
        { filename: filename, message: error.response.data.message },
      ],
    }));
  };

  onFileUploadEditor = async (filename, payload, options) => {
    const { onFileUpload, onFilesChange, files } = this.props;

    const json = await onFileUpload(filename, payload, options);
    // Convert the response format when uploading a file,
    // to the same response format as when retrieving an entity with files.
    onFilesChange([
      ...files,
      {
        file_id: json.data.id,
        key: json.data.key,
        original_filename: json.data.metadata.original_filename,
        size: json.data.size,
        mimetype: json.data.mimetype,
        links: {
          download_html: json.data.links.download_html,
        },
      },
    ]);
    return json;
  };

  onFileDeleteEditor = async (file) => {
    const { onFileDelete, onFilesChange, files } = this.props;

    try {
      if (onFileDelete) {
        await onFileDelete(file);
      }
      onFilesChange(files.filter((fileFromList) => fileFromList.key !== file.key));
    } catch (error) {
      this.addToFileErrors(file.original_filename, error);
    }
  };

  /**
   * This function is called when a user drag-n-drops an image onto the editor text area.
   * Used only when files are enabled (record with file upload backend).
   */
  imagesUploadHandler = async (blobInfo, progress) => {
    const filename = blobInfo.filename();
    const payload = blobInfo.blob();

    try {
      const json = await this.onFileUploadEditor(filename, payload, {
        onUploadProgress: ({ loaded, total }) =>
          progress(Math.round((loaded / total) * 100)),
      });
      progress(100);
      return new URL(json.data.links.download_html).pathname;
    } catch (error) {
      this.addToFileErrors(filename, error);
      throw error;
    }
  };

  /**
   * Used when no file upload backend is available (e.g. the description field).
   * Compresses the image to a target of 200KB and returns a base64 data URL
   * which gets embedded directly in the HTML content.
   */
  imagesBase64UploadHandler = async (blobInfo, progress) => {
    const imageFile = blobInfo.blob();
    const targetSizeBytes = 200 * 1024;
    let finalImage = imageFile;

    if (imageFile.size > targetSizeBytes) {
      try {
        finalImage = await imageCompression(imageFile, {
          maxSizeMB: 0.2,
          useWebWorker: true,
          fileType: imageFile.type,
        });
      } catch (compressionError) {
        console.warn("Image compression failed, using original:", compressionError);
      }
    }

    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.readAsDataURL(finalImage);
      reader.onloadend = () => {
        progress(100);
        resolve(reader.result);
      };
      reader.onerror = () => reject(new Error("Failed to encode image as base64"));
    });
  };

  /**
   * This function is called when a a user clicks on the upload icons
   * in the Link and Image popup dialogs.
   */
  filePickerCallback = (callback, value, meta) => {
    const input = document.createElement("input");
    input.setAttribute("type", "file");

    // If the file picker is called from the Image dialog, only allow to upload images (allow everything from the Link dialog).
    if (meta.filetype === "image") {
      if (this.editorRef.current) {
        // List of image extensions documented in:
        // https://www.tiny.cloud/docs/tinymce/latest/image/#images_file_types

        // We could accept "image/*", but then we would let users upload and inline SVG files from the image upload dialog,
        // but this would not work since we are forbidding the rendering of inline SVG for security reasons
        // (see MIMETYPE_PLAINTEXT in invenio_files_rest).
        const imagesFileTypes = this.editorRef.current.options.get("images_file_types");
        const inputAccept = imagesFileTypes
          .split(",")
          .map((imageExtension) => "." + imageExtension)
          .join(", ");
        input.setAttribute("accept", inputAccept);
      }
    }

    input.onchange = (event) => {
      const file = event.target.files[0];
      const filename = file.name;

      if (this.editorRef.current) {
        // This progress state is visible when uploading via the attach button,
        // but it is hidden behind the Link and Image popup dialogs when using them.
        this.editorRef.current.setProgressState(true);
      }

      // Progress state visible when uploading via the the Link and Image popup dialogs.
      // Taken from: https://github.com/tinymce/tinymce/issues/5133
      if (this.editorDialogRef.current) {
        this.editorDialogRef.current.block("Uploading file...");
      }

      const reader = new FileReader();
      reader.onload = async () => {
        try {
          const json = await this.onFileUploadEditor(filename, reader.result);

          if (this.editorRef.current) {
            this.editorRef.current.setProgressState(false);
          }
          if (this.editorDialogRef.current) {
            this.editorDialogRef.current.unblock();
          }

          const locationRelative = new URL(json.data.links.download_html).pathname;
          if (meta.filetype === "file") {
            callback(locationRelative, { text: json.data.metadata.original_filename });
          } else if (meta.filetype === "image") {
            callback(locationRelative, {
              alt: `Description of ${json.data.metadata.original_filename}`,
            });
          } else {
            // This should not happen, since `file_picker_types` is set to only support `file` and `image`.
            callback(locationRelative);
          }
        } catch (error) {
          this.addToFileErrors(filename, error);
          if (this.editorRef.current) {
            this.editorRef.current.setProgressState(false);
          }
          if (this.editorDialogRef.current) {
            this.editorDialogRef.current.unblock();
          }
        }
      };
      reader.readAsArrayBuffer(file);
    };
    input.click();
  };

  /**
   * This function is called when a a user clicks on the attach files toolbar button,
   * or on the attach files button next to the files list.
   */
  onAttachFiles = () => {
    this.filePickerCallback(() => { }, "", "file");
  };

  mapToEditorLinkList = (files) => {
    return files.map((file) => ({
      title: file.original_filename,
      value: new URL(file.links.download_html).pathname,
    }));
  };

  getImageList = () => {
    const { files } = this.props;

    if (this.editorRef.current) {
      // List of image extensions documented in:
      // https://www.tiny.cloud/docs/tinymce/latest/image/#images_file_types
      const imagesFileTypes = this.editorRef.current.options.get("images_file_types");
      const imagesExtensions = imagesFileTypes.split(",");

      const images = files.filter((file) => {
        const filename = file.original_filename;
        const extension = filename.slice(filename.lastIndexOf(".") + 1).toLowerCase();
        return imagesExtensions.includes(extension);
      });

      return this.mapToEditorLinkList(images);
    } else {
      return this.mapToEditorLinkList(files);
    }
  };

  getLinkList = () => {
    const { files } = this.props;
    return this.mapToEditorLinkList(files);
  };

  registerCustomPreviewButton = (editor) => {
    const customPreviewTitle = "Preview math equations";
    editor.ui.registry.addButton("custom_preview", {
      text: "√x",
      tooltip: customPreviewTitle,
      context: "any",
      onAction: () => {
        editor.execCommand("mcePreview");
        const dialog = document.querySelector(".tox-dialog");
        if (dialog) {
          // Change the title
          const title = dialog.querySelector(".tox-dialog__title");
          if (title) {
            title.textContent = customPreviewTitle; // Your custom title
          }
          const iframe = dialog.querySelector("iframe");
          // Handle iframe load to render MathJax by passing the iframe document body to MathJax.typesetPromise
          iframe.onload = () => {
            window.MathJax?.typesetPromise([iframe.contentDocument.body]);
          };
        }
      },
    });
  };

  registerAttachButton = (editor) => {
    editor.ui.registry.addButton("attach", {
      icon: "upload",
      tooltip: "Attach files",
      onAction: () => this.onAttachFiles(),
    });
  };

  registerMarkdownButton = (editor) => {
    editor.ui.registry.addButton("markdownimport", {
      text: "MD",
      tooltip: "Import Markdown",
      onAction: () => this.openMarkdownDialog(editor),
    });
  };

  convertMarkdownToHTML = (markdown) => {
    marked.setOptions({ breaks: true, gfm: true });
    const rawHtml = marked.parse(markdown);
    return DOMPurify.sanitize(rawHtml, {
      ALLOWED_TAGS: [
        "h1", "h2", "h3", "h4", "h5", "h6",
        "p", "br", "strong", "em", "u", "strike",
        "ul", "ol", "li",
        "a", "code", "pre", "blockquote",
        "table", "thead", "tbody", "tr", "th", "td",
        "hr", "img", "div", "span",
      ],
      ALLOWED_ATTR: ["href", "src", "alt", "title", "class", "id"],
    });
  };

  openMarkdownDialog = (editor) => {
    editor.windowManager.open({
      title: "Import Markdown",
      body: {
        type: "panel",
        items: [{ type: "htmlpanel", html: "<p>Choose how to import:</p>" }],
      },
      buttons: [
        { type: "custom", name: "uploadfile", text: "Upload .md File" },
        { type: "custom", name: "pastetext", text: "Paste Markdown", primary: true },
        { type: "cancel", text: "Cancel" },
      ],
      onAction: (dialogApi, details) => {
        if (details.name === "uploadfile") {
          dialogApi.close();
          this.uploadMarkdownFile(editor);
        } else if (details.name === "pastetext") {
          dialogApi.close();
          this.pasteMarkdownText(editor);
        }
      },
    });
  };

  uploadMarkdownFile = (editor) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".md,.markdown,text/markdown,text/plain";
    input.onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        editor.insertContent(this.convertMarkdownToHTML(text));
        editor.notificationManager.open({
          text: `Markdown imported: ${file.name}`,
          type: "success",
          timeout: 3000,
        });
      } catch (error) {
        editor.notificationManager.open({
          text: `Failed: ${error.message}`,
          type: "error",
          timeout: 5000,
        });
      }
    };
    input.click();
  };

  pasteMarkdownText = (editor) => {
    editor.windowManager.open({
      title: "Paste Markdown",
      size: "large",
      body: {
        type: "panel",
        items: [
          {
            type: "textarea",
            name: "markdown",
            label: "Markdown Content",
            placeholder: "# Heading\n\n**Bold text**\n\n- List item",
          },
        ],
      },
      buttons: [
        { type: "cancel", text: "Cancel" },
        { type: "submit", text: "Import", primary: true },
      ],
      onSubmit: (dialogApi) => {
        const data = dialogApi.getData();
        if (data.markdown && data.markdown.trim()) {
          editor.insertContent(this.convertMarkdownToHTML(data.markdown));
          dialogApi.close();
          editor.notificationManager.open({
            text: "Markdown imported!",
            type: "success",
            timeout: 3000,
          });
        }
      },
    });
  };

  render() {
    const localRefEditorDialogRef = this.editorDialogRef;

    const {
      id,
      initialValue,
      disabled,
      minHeight,
      onBlur,
      onChange,
      onFocus,
      editorConfig,
      inputValue,
      onEditorChange,
      files,
      onInit,
    } = this.props;
    const { fileErrors } = this.state;
    const attachFilesEnabled = files !== undefined;
    let config = {
      branding: false,
      menubar: false,
      statusbar: false,
      license_key: "gpl",
      promotion: false,
      min_height: minHeight,
      toolbar_mode: "wrap",
      content_style: editorContentStyle(disabled),
      plugins: [
        "advlist",
        "autolink",
        "autoresize",
        "charmap",
        "code",
        "codesample",
        "fullscreen",
        "image",
        "insertdatetime",
        "link",
        "lists",
        "media",
        "preview",
        "searchreplace",
        "table",
        "visualblocks",
        "wordcount",
      ],
      contextmenu: false,
      toolbar: `blocks | bold italic underline strikethrough | bullist numlist | outdent indent | link image ${attachFilesEnabled ? "attach " : " "
        }| codesample blockquote table | markdownimport | wordcount | undo redo | code | custom_preview`,
      autoresize_bottom_margin: 20,
      block_formats: "Paragraph=p; Header 1=h1; Header 2=h2; Header 3=h3",
      table_advtab: false,
      image_advtab: true,
      convert_urls: false,
      paste_data_images: true,
      // When no file backend is available (e.g. description field), images are
      // compressed and embedded as base64 data URLs directly in the content.
      images_upload_handler: this.imagesBase64UploadHandler,
      setup: (editor) => {
        this.registerCustomPreviewButton(editor);
        this.registerMarkdownButton(editor);
        editor.on("OpenWindow", function (eventDetails) {
          if (attachFilesEnabled) {
            localRefEditorDialogRef.current = eventDetails.dialog;
          }
          requestAnimationFrame(() => {
            const dialog = document.querySelector(".tox-dialog");
            if (!dialog) return;
            const title = dialog.querySelector(".tox-dialog__title");
            if (title && title.textContent.trim() === "Insert/Edit Image") {

              const hideSourceField = () => {
                dialog.querySelectorAll(".tox-form__group").forEach((group) => {
                  const label = group.querySelector("label");
                  if (label && label.textContent.trim() === "Source") {
                    group.style.display = "none";
                  }
                });
              };

              // Hide on initial open
              hideSourceField();

              // Move Upload tab to first position and activate it by default
              const navBar = dialog.querySelector(".tox-dialog__body-nav");
              if (navBar) {
                const navItems = Array.from(navBar.querySelectorAll(".tox-dialog__body-nav-item"));
                const uploadTab = navItems.find((item) => item.textContent.trim() === "Upload");
                if (uploadTab) {
                  uploadTab.click();
                  navBar.insertBefore(uploadTab, navBar.firstChild);
                }
              }

              // MutationObserver: re-hide Source whenever TinyMCE re-renders dialog content
              // (tab switches, post-upload auto-switch to General tab, etc.)
              const dialogBody = dialog.querySelector(".tox-dialog__body-content");
              if (dialogBody && !dialogBody._sourceObserver) {
                const observer = new MutationObserver(() => hideSourceField());
                observer.observe(dialogBody, { childList: true, subtree: true });
                dialogBody._sourceObserver = observer;
                // Clean up when dialog closes
                dialog.addEventListener("remove", () => observer.disconnect(), { once: true });
              }

              // Enter key anywhere in the dialog clicks Save
              if (!dialog._enterHooked) {
                dialog._enterHooked = true;
                dialog.addEventListener("keydown", (e) => {
                  if (e.key === "Enter") {
                    if (e.target.tagName === "TEXTAREA") return;
                    e.preventDefault();
                    const saveBtn = Array.from(
                      dialog.querySelectorAll(".tox-dialog__footer .tox-button")
                    ).find((btn) => btn.textContent.trim() === "Save");
                    if (saveBtn) saveBtn.click();
                  }
                });
              }
            }
          });
        });
        if (attachFilesEnabled) {
          this.registerAttachButton(editor);
        }
      },
      ...editorConfig,
    };

    if (attachFilesEnabled) {
      config = {
        ...config,
        // No need for TinyMCE to generate unique filenames since we delegate this responsibility to the backend.
        images_reuse_filename: true,
        // Override the base64 handler with the full server-upload handler (with compression).
        images_upload_handler: this.imagesUploadHandler,
        // We do not implement the file picker type `media` since we do not enable the Media plugin/button.
        file_picker_types: "file image",
        // This function is called when a a user clicks on the upload icons
        // in the Link and Image popup dialogs.
        file_picker_callback: this.filePickerCallback,
        // Pre-filled link list in the Image popup dialog.
        image_list: (success) => {
          success(this.getImageList());
        },
        // Pre-filled link list in the Link popup dialog.
        link_list: (success) => {
          success(this.getLinkList());
        },
        // Disabling the separated image upload tab in the Image dialog,
        // since it is a bit redundant with the little upload icon next to the filename.
        image_uploadtab: false,
      };
    }

    return (
      <>
        <Editor
          licenseKey="gpl"
          initialValue={initialValue}
          value={typeof inputValue === "string" ? inputValue : undefined}
          init={config}
          id={id}
          disabled={disabled}
          onBlur={async (event, editor) => {
            // Wait for any pending image uploads (e.g. base64 conversion) to
            // complete before notifying parent. Without this, getContent() in
            // the onBlur handler (RichInputField) would still contain blob: URLs
            // which are lost after page reload.
            await editor.uploadImages();
            onBlur && onBlur(event, editor);
          }}
          onFocus={onFocus}
          onChange={onChange}
          onEditorChange={(content, editor) => {
            // Skip updating parent state while images are still being processed
            // (blob: URLs are temporary and will be replaced by the upload handler).
            // Forwarding blob: URLs to Redux would cause them to be pushed back as
            // `value`, overwriting the final base64/server URL with the stale blob.
            if (onEditorChange && !content.includes("blob:")) {
              onEditorChange(content, editor);
            }
          }}
          onInit={(event, editor) => {
            this.editorRef.current = editor;
            onInit && onInit(event, editor);
          }}
        />
        {attachFilesEnabled && (
          <>
            {fileErrors.length > 0 && (
              <Message negative>
                <ul>
                  {fileErrors?.map((fileError, index) => (
                    // We always add errors to the end of the list,
                    // so the elements rendered at a specific index do not change.
                    // eslint-disable-next-line react/no-array-index-key
                    <li key={index}>
                      {fileError.filename}: {fileError.message}
                    </li>
                  ))}
                </ul>
              </Message>
            )}
            <FilesList files={files} onFileDelete={this.onFileDeleteEditor} />
            <div>
              <Button
                basic
                size="small"
                compact
                icon="attach"
                content="Attach files"
                className="mt-5"
                onClick={() => this.onAttachFiles()}
              />
            </div>
          </>
        )}
      </>
    );
  }
}

RichEditor.propTypes = {
  initialValue: PropTypes.string,
  inputValue: PropTypes.string,
  id: PropTypes.string,
  disabled: PropTypes.bool,
  onChange: PropTypes.func,
  onEditorChange: PropTypes.func,
  onBlur: PropTypes.func,
  onFocus: PropTypes.func,
  onInit: PropTypes.func,
  minHeight: PropTypes.number,
  editorConfig: PropTypes.object,
  files: PropTypes.array,
  onFilesChange: PropTypes.func,
  onFileUpload: PropTypes.func,
  onFileDelete: PropTypes.func,
};

RichEditor.defaultProps = {
  minHeight: 250,
  initialValue: "",
  inputValue: "",
  id: undefined,
  disabled: undefined,
  onChange: undefined,
  onEditorChange: undefined,
  onBlur: undefined,
  onFocus: undefined,
  onInit: undefined,
  editorConfig: undefined,
  files: undefined,
  onFilesChange: undefined,
  onFileUpload: undefined,
  onFileDelete: undefined,
};
