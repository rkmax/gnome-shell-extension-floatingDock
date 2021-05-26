PROJECT=floatingDock@sun.wxg@gmail.com

build: schemas
	mkdir -p build
	gnome-extensions pack ${PROJECT} -f -o build
	cd ${PROJECT} && zip -q -r ../build/*.zip * # workaround pack doesnt include additional .js and .ui files
schemas:
	glib-compile-schemas ${PROJECT}/schemas/
install: build
	gnome-extensions install -f build/*.zip
clean:
	rm -rf build
	rm ${PROJECT}/schemas/*.compiled
