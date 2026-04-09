import { marked } from 'marked';
import DOMPurify from 'dompurify';

export const registerMarkdownImportPlugin = () => {
    window.tinymce.PluginManager.add('markdownimport', function (editor, url) {

        // Add toolbar button
        editor.ui.registry.addButton('markdownimport', {
            text: 'Import Markdown',
            icon: 'code-sample',
            tooltip: 'Import Markdown content',
            onAction: function () {
                openMarkdownDialog(editor);
            }
        });

        // Add menu item
        editor.ui.registry.addMenuItem('markdownimport', {
            text: 'Import Markdown',
            icon: 'sourcecode',
            onAction: function () {
                openMarkdownDialog(editor);
            }
        });

        return {
            getMetadata: function () {
                return {
                    name: 'Markdown Import Plugin',
                    url: 'https://your-project.com'
                };
            }
        };
    });
};

function openMarkdownDialog(editor) {
    editor.windowManager.open({
        title: 'Import Markdown',
        body: {
            type: 'panel',
            items: [
                {
                    type: 'htmlpanel',
                    html: '<p style="margin-bottom: 10px;">Choose how to import Markdown content:</p>'
                }
            ]
        },
        buttons: [
            {
                type: 'custom',
                name: 'uploadfile',
                text: 'Upload .md File',
                primary: false
            },
            {
                type: 'custom',
                name: 'pastetext',
                text: 'Paste Markdown',
                primary: true
            },
            {
                type: 'cancel',
                text: 'Cancel'
            }
        ],
        onAction: function (dialogApi, details) {
            if (details.name === 'uploadfile') {
                dialogApi.close();
                openMarkdownFilePicker(editor);
            } else if (details.name === 'pastetext') {
                dialogApi.close();
                openMarkdownPasteDialog(editor);
            }
        }
    });
}

// Option 1: Upload .md file
function openMarkdownFilePicker(editor) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.md,.markdown,text/markdown,text/plain';

    input.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;

        // Show progress
        const notification = editor.notificationManager.open({
            text: 'Importing Markdown file...',
            type: 'info',
            closeButton: false
        });

        try {
            const text = await file.text();
            const html = convertMarkdownToHTML(text, file.name);
            editor.insertContent(html);

            notification.close();
            editor.notificationManager.open({
                text: `✓ Markdown imported from: ${file.name}`,
                type: 'success',
                timeout: 3000
            });
        } catch (error) {
            notification.close();
            editor.notificationManager.open({
                text: 'Failed to import Markdown: ' + error.message,
                type: 'error',
                timeout: 5000
            });
            console.error('Markdown import error:', error);
        }
    };

    input.click();
}

// Option 2: Paste Markdown text
function openMarkdownPasteDialog(editor) {
    editor.windowManager.open({
        title: 'Paste Markdown Content',
        size: 'large',
        body: {
            type: 'panel',
            items: [
                {
                    type: 'textarea',
                    name: 'markdown',
                    label: 'Markdown Content',
                    placeholder: '# Example\n\nPaste your **Markdown** here...\n\n- Item 1\n- Item 2',
                    maximized: true
                },
                {
                    type: 'htmlpanel',
                    html: '<p style="margin-top: 10px; color: #666; font-size: 12px;">' +
                        '<strong>Tip:</strong> Supports standard Markdown syntax including headers, lists, links, bold, italic, code blocks, etc.</p>'
                }
            ]
        },
        buttons: [
            {
                type: 'cancel',
                text: 'Cancel'
            },
            {
                type: 'submit',
                text: 'Import',
                primary: true
            }
        ],
        onSubmit: function (dialogApi) {
            const data = dialogApi.getData();
            const markdown = data.markdown;

            if (markdown && markdown.trim()) {
                const html = convertMarkdownToHTML(markdown, 'pasted content');
                editor.insertContent(html);
                dialogApi.close();

                editor.notificationManager.open({
                    text: '✓ Markdown content imported successfully!',
                    type: 'success',
                    timeout: 3000
                });
            } else {
                editor.notificationManager.open({
                    text: 'Please enter some Markdown content',
                    type: 'warning',
                    timeout: 3000
                });
            }
        }
    });
}

function convertMarkdownToHTML(markdown, sourceName) {
    // Configure marked for better output
    marked.setOptions({
        breaks: true,           // Convert \n to <br>
        gfm: true,             // GitHub Flavored Markdown
        headerIds: true,       // Add IDs to headers
        mangle: false,         // Don't escape autolinked email
        pedantic: false,       // Don't be too strict
        smartLists: true,      // Better list parsing
        smartypants: false     // Don't use smart typography
    });

    // Convert markdown to HTML
    const rawHtml = marked.parse(markdown);

    // Sanitize HTML to prevent XSS attacks
    const cleanHtml = DOMPurify.sanitize(rawHtml, {
        ALLOWED_TAGS: [
            'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
            'p', 'br', 'strong', 'em', 'u', 'strike', 'del',
            'ul', 'ol', 'li',
            'a', 'code', 'pre', 'blockquote',
            'table', 'thead', 'tbody', 'tr', 'th', 'td',
            'hr', 'img', 'div', 'span'
        ],
        ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'class', 'id']
    });

    // Wrap in a styled container
    return cleanHtml;
}
