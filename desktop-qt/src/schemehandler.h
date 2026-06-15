#pragma once

// Serves the built Angular client over a custom `fliks://` scheme (Angular
// history routing → SPA fallback to index.html), mirroring the Electron shell's
// fliks:// protocol. The web root is FLIKS_WEB_DIR (the built client/browser).
#include <QtWebEngineCore/QWebEngineUrlSchemeHandler>
#include <QString>

class FliksSchemeHandler : public QWebEngineUrlSchemeHandler {
    Q_OBJECT
public:
    explicit FliksSchemeHandler(QString root, QObject *parent = nullptr);
    void requestStarted(QWebEngineUrlRequestJob *job) override;

private:
    QString m_root;
};
