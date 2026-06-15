#include "schemehandler.h"

#include <QtWebEngineCore/QWebEngineUrlRequestJob>
#include <QFile>
#include <QFileInfo>
#include <QMimeDatabase>
#include <QUrl>

FliksSchemeHandler::FliksSchemeHandler(QString root, QObject *parent)
    : QWebEngineUrlSchemeHandler(parent), m_root(std::move(root)) {}

void FliksSchemeHandler::requestStarted(QWebEngineUrlRequestJob *job) {
    QString path = job->requestUrl().path();
    if (path.isEmpty() || path == QLatin1String("/"))
        path = QStringLiteral("/index.html");

    QString file = m_root + path;
    QFileInfo fi(file);
    const QString lastSeg = path.section('/', -1);
    if (!lastSeg.contains('.')) {
        // A route (no file extension) → index.html so Angular's router runs.
        file = m_root + QStringLiteral("/index.html");
    } else if (!fi.exists() || !fi.isFile()) {
        // A missing ASSET (e.g. the relative-loaded Cast SDK) → clean 404, not
        // index.html — serving HTML for a .js/.css yields "Unexpected token <".
        job->fail(QWebEngineUrlRequestJob::UrlNotFound);
        return;
    }

    auto *f = new QFile(file, job);
    if (!f->open(QIODevice::ReadOnly)) {
        job->fail(QWebEngineUrlRequestJob::UrlNotFound);
        return;
    }

    QByteArray mime;
    if (file.endsWith(QLatin1String(".js")) || file.endsWith(QLatin1String(".mjs")))
        mime = "text/javascript";
    else if (file.endsWith(QLatin1String(".css")))
        mime = "text/css";
    else if (file.endsWith(QLatin1String(".html")))
        mime = "text/html";
    else if (file.endsWith(QLatin1String(".json")))
        mime = "application/json";
    else if (file.endsWith(QLatin1String(".svg")))
        mime = "image/svg+xml";
    else if (file.endsWith(QLatin1String(".wasm")))
        mime = "application/wasm";
    else
        mime = QMimeDatabase().mimeTypeForFile(file).name().toUtf8();

    job->reply(mime, f);
}
