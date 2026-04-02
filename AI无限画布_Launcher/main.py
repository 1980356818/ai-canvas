import sys
import os

from PySide6.QtWidgets import QApplication
from PySide6.QtCore import QFile, QTextStream

from ui.main_window import MainWindow


def load_stylesheet(app: QApplication):
    qss_path = os.path.join(os.path.dirname(__file__), "ui", "styles.qss")
    f = QFile(qss_path)
    if f.open(QFile.OpenModeFlag.ReadOnly | QFile.OpenModeFlag.Text):
        stream = QTextStream(f)
        app.setStyleSheet(stream.readAll())
        f.close()


def main():
    app = QApplication(sys.argv)
    load_stylesheet(app)

    window = MainWindow()
    window.show()

    sys.exit(app.exec())


if __name__ == "__main__":
    main()
